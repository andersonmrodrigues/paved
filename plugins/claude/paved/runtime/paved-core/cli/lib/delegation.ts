import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";
import type { Run } from "./workflow-runs.ts";

export interface DelegationAttempt {
  host: "claude-code" | "codex";
  selected_model: string;
  selected_effort: string;
  selected_by: "host" | "agent" | "human";
  session_sha256?: string;
  started_at: string;
  finished_at?: string;
  outcome?: "completed" | "blocked" | "failed";
  usage?: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; cost_usd?: number; duration_ms?: number };
}

export interface DelegationTask {
  id: string;
  title: string;
  brief: string;
  depends_on: string[];
  read_paths: string[];
  write_paths: string[];
  output_contract: string;
  model_policy: { capacity: "economy" | "balanced" | "frontier"; reasoning_effort: "low" | "medium" | "high"; rationale: string };
  status?: "pending" | "running" | "completed" | "blocked" | "failed";
  attempts?: DelegationAttempt[];
  result?: { path: string; sha256: string };
}

export interface DelegationPlan {
  apiVersion: "paved/v1";
  kind: "DelegationPlan";
  id: string;
  run: string;
  plan_sha256: string;
  max_concurrency: number;
  tasks: DelegationTask[];
}

export function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function graphPath(projectRoot: string, runId: string): string {
  return resolveSafePath(projectRoot, `.paved/generated/delegations/${runId}.yaml`);
}

function dependencyClosure(task: DelegationTask, byId: ReadonlyMap<string, DelegationTask>, seen = new Set<string>()): Set<string> {
  for (const id of task.depends_on) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (dependency) dependencyClosure(dependency, byId, seen);
  }
  return seen;
}

function pathsOverlap(left: string, right: string): boolean {
  const a = left.replace(/\/$/, "");
  const b = right.replace(/\/$/, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function validateDelegationPlan(coreRoot: string, plan: unknown): asserts plan is DelegationPlan {
  const result = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(plan);
  if (!result.valid) throw new Error(`Delegation plan is invalid: ${result.errors.join("; ")}`);
  const graph = plan as DelegationPlan;
  const byId = new Map<string, DelegationTask>();
  for (const task of graph.tasks) {
    if (byId.has(task.id)) throw new Error(`Delegation task id ${task.id} is duplicated.`);
    byId.set(task.id, task);
    for (const path of task.write_paths) {
      if (/[?*\[\]{}]/.test(path)) throw new Error(`Delegation task ${task.id} must use exact write paths; glob found in ${path}.`);
      if (path === ".git" || path.startsWith(".git/") || path === ".paved/generated" || path.startsWith(".paved/generated/")) {
        throw new Error(`Delegation task ${task.id} cannot write Paved run state or Git metadata: ${path}.`);
      }
    }
  }
  for (const task of graph.tasks) {
    for (const dependency of task.depends_on) {
      if (dependency === task.id) throw new Error(`Delegation task ${task.id} cannot depend on itself.`);
      if (!byId.has(dependency)) throw new Error(`Delegation task ${task.id} depends on unknown task ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Delegation dependency cycle includes task ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);

  for (let i = 0; i < graph.tasks.length; i += 1) {
    const left = graph.tasks[i]!;
    for (const right of graph.tasks.slice(i + 1)) {
      const ordered = dependencyClosure(left, byId).has(right.id) || dependencyClosure(right, byId).has(left.id);
      if (ordered) continue;
      const collision = left.write_paths.find((a) => right.write_paths.some((b) => pathsOverlap(a, b)));
      if (collision) throw new Error(`Parallel delegation tasks ${left.id} and ${right.id} both write ${collision}; declare a dependency or split the write scope.`);
    }
  }
}

export function readDelegation(projectRoot: string, coreRoot: string, run: Run): DelegationPlan | undefined {
  if (!run.delegation) return undefined;
  const expectedPath = `.paved/generated/delegations/${run.id}.yaml`;
  if (run.delegation.path !== expectedPath) throw new Error(`Delegation plan must use its canonical path ${expectedPath}.`);
  const approved = approvedPlanDigest(run);
  if (!approved || approved !== run.delegation.plan_sha256) throw new Error("Delegation plan is not bound to the currently approved workflow plan.");
  const path = resolveSafePath(projectRoot, run.delegation.path);
  if (!existsSync(path)) throw new Error(`Delegation plan ${run.delegation.path} is missing.`);
  const bytes = readFileSync(path);
  if (digest(bytes) !== run.delegation.sha256) throw new Error(`Delegation plan ${run.delegation.path} changed after registration; amend the workflow plan to replace it.`);
  const plan = loadYaml(path) as unknown;
  validateDelegationPlan(coreRoot, plan);
  const graph = plan as DelegationPlan;
  if (graph.run !== run.id || graph.id !== run.id) throw new Error(`Delegation plan ${run.delegation.path} belongs to another run.`);
  if (graph.plan_sha256 !== run.delegation.plan_sha256) throw new Error(`Delegation plan ${run.delegation.path} has stale plan provenance.`);
  for (const task of graph.tasks) {
    if (!task.result) continue;
    const prefix = `.paved/generated/delegation-results/${run.id}/`;
    if (!task.result.path.startsWith(prefix)) throw new Error(`Delegation result for ${task.id} must be stored under ${prefix}.`);
    const resultPath = resolveSafePath(projectRoot, task.result.path);
    if (!existsSync(resultPath) || digest(readFileSync(resultPath)) !== task.result.sha256) throw new Error(`Delegation result for ${task.id} is missing or changed.`);
  }
  return graph;
}

export function writeDelegation(projectRoot: string, graph: DelegationPlan): { path: string; sha256: string } {
  const path = graphPath(projectRoot, graph.run);
  mkdirSync(dirname(path), { recursive: true });
  const contents = stringify(graph);
  atomicWriteFileSync(path, contents);
  return { path: `.paved/generated/delegations/${graph.run}.yaml`, sha256: digest(contents) };
}

export function readyTasks(graph: DelegationPlan): DelegationTask[] {
  const completed = new Set(graph.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return graph.tasks.filter((task) => ((task.status ?? "pending") === "pending" || task.status === "failed") && task.depends_on.every((id) => completed.has(id)));
}

export function approvedPlanDigest(run: Run): string | undefined {
  const gate = run.phases.find((phase) => phase.phase === "planning")?.gates?.find((item) => item.id === "plan-approved");
  const match = /^plan_sha256=([a-f0-9]{64})$/.exec(gate?.reason ?? "");
  return gate?.status === "approved" ? match?.[1] : undefined;
}
