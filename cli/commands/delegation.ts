import { existsSync, readFileSync } from "node:fs";
import { loadYaml } from "../lib/documents.ts";
import { resolveSafePath } from "../lib/safe-path.ts";
import { readRun, writeRun, type Run } from "../lib/workflow-runs.ts";
import { approvedPlanDigest, digest, readDelegation, readyTasks, validateDelegationPlan, writeDelegation, type DelegationPlan, type DelegationTask, type DelegationAttempt } from "../lib/delegation.ts";
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";

const completed = (task: DelegationTask) => task.status === "completed";
const active = (task: DelegationTask) => task.status === "running";

function failure(message: string, remediation: string): CommandResult {
  return createResult({ command: "delegation", status: "failed", diagnostics: [createDiagnostic({
    severity: "error", category: "config", code: "PAVED_DELEGATION_INVALID",
    component: "workflow.delegation", message, remediation,
  })] });
}

function graphResult(run: Run, graph: DelegationPlan, note: string): CommandResult {
  const ready = readyTasks(graph);
  return createResult({ command: "delegation", status: "success", data: {
    run: run.id,
    path: `.paved/generated/delegations/${run.id}.yaml`,
    planSha256: graph.plan_sha256,
    maxConcurrency: graph.max_concurrency,
    running: graph.tasks.filter(active).map(({ id }) => id),
    ready: ready.map(({ id, title, brief, read_paths, write_paths, output_contract, model_policy }) => ({ id, title, brief, readPaths: read_paths, writePaths: write_paths, outputContract: output_contract, modelPolicy: model_policy })),
    completed: graph.tasks.filter(completed).map(({ id }) => id),
    incomplete: graph.tasks.filter((task) => !completed(task)).map(({ id, status }) => ({ id, status: status ?? "pending" })),
    note,
  } });
}

function requireImplementation(run: Run): string {
  const phase = run.phases.find((item) => item.status === "running");
  if (phase?.phase !== "implementation" || run.status !== "running") throw new Error(`Delegation is available only while run ${run.id} is in implementation.`);
  const planSha = approvedPlanDigest(run);
  if (!planSha) throw new Error(`Run ${run.id} does not have an approved plan digest.`);
  return planSha;
}

function noWriteConflict(graph: DelegationPlan, task: DelegationTask): void {
  for (const running of graph.tasks.filter((item) => item.status === "running")) {
    const conflict = task.write_paths.find((left) => running.write_paths.some((right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
    if (conflict) throw new Error(`Task ${task.id} would edit ${conflict} while ${running.id} is running.`);
  }
}

function readUsage(raw: string | undefined): DelegationAttempt["usage"] {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("--usage must be valid JSON."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("--usage must be a JSON object.");
  const result = value as Record<string, unknown>;
  const valid = ["input_tokens", "output_tokens", "reasoning_tokens", "cost_usd", "duration_ms"];
  for (const [key, amount] of Object.entries(result)) {
    if (!valid.includes(key) || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new Error(`Invalid usage field ${key}.`);
    if (key !== "cost_usd" && !Number.isInteger(amount)) throw new Error(`Usage field ${key} must be an integer.`);
  }
  return result as DelegationAttempt["usage"];
}

export function delegationHandler(invocation: CommandInvocation): CommandResult {
  const [operation] = invocation.selectors;
  const { projectRoot, coreRoot } = invocation.paths;
  const runId = invocation.flags.run;
  if (!operation || invocation.selectors.length !== 1) return failure("Choose one operation: plan, ready, start or finish.", "Run paved delegation --help to see the operation and its required flags.");
  if (!runId) return failure("--run is required.", "Pass the current workflow run id.");
  try {
    const run = readRun(projectRoot, coreRoot, runId);
    if (!run) throw new Error(`Workflow run ${runId} does not exist.`);
    const planSha = requireImplementation(run);

    if (operation === "plan") {
      if (!invocation.flags.file) throw new Error("plan requires --file <path>.");
      if (run.delegation) throw new Error("A delegation graph is already registered. Amend the approved plan before replacing it.");
      const inputPath = resolveSafePath(projectRoot, invocation.flags.file);
      if (!existsSync(inputPath)) throw new Error(`Delegation graph file does not exist: ${invocation.flags.file}.`);
      const graph = loadYaml(inputPath) as unknown;
      validateDelegationPlan(coreRoot, graph);
      const plan = graph as DelegationPlan;
      if (plan.id !== run.id || plan.run !== run.id) throw new Error(`Delegation graph id and run must both be ${run.id}.`);
      if (plan.plan_sha256 !== planSha) throw new Error("Delegation graph does not match the approved plan digest.");
      for (const task of plan.tasks) { task.status = "pending"; task.attempts = []; delete task.result; }
      const stored = writeDelegation(projectRoot, plan);
      run.delegation = { path: stored.path, sha256: stored.sha256, plan_sha256: plan.plan_sha256 };
      run.events.push({ at: new Date().toISOString(), type: "delegation-registered", phase: "implementation", ref: stored.path, detail: `sha256=${stored.sha256}` });
      writeRun(projectRoot, coreRoot, run);
      return graphResult(run, plan, "Graph is registered and bound to the approved plan. Start only the listed ready tasks with the selected host's native agent/session tools.");
    }

    const graph = readDelegation(projectRoot, coreRoot, run);
    if (!graph) throw new Error(`Run ${run.id} has no delegation graph. Register one with paved delegation plan --run ${run.id} --file <graph.yaml>.`);
    if (operation === "ready") return graphResult(run, graph, "Use the host's native agent/session tools. A delegated result is not verification; inspect changes and run the required checks in the primary session.");

    const task = graph.tasks.find((item) => item.id === invocation.flags.task);
    if (!task) throw new Error("Pass --task with an id from this delegation graph.");
    if (operation === "start") {
      const { host, model, effort } = invocation.flags;
      if (host !== "codex" && host !== "claude-code") throw new Error("start requires --host codex or --host claude-code.");
      if (!model || !effort) throw new Error("start requires the actual --model and --effort selected by the host.");
      if (task.status !== undefined && task.status !== "pending" && task.status !== "failed") throw new Error(`Task ${task.id} is ${task.status}; only pending or failed tasks may start.`);
      if (!readyTasks(graph).some((item) => item.id === task.id)) throw new Error(`Task ${task.id} is not ready; complete its dependencies first.`);
      if (graph.tasks.filter(active).length >= graph.max_concurrency) throw new Error(`Delegation concurrency limit ${graph.max_concurrency} has been reached.`);
      noWriteConflict(graph, task);
      const selectedBy = invocation.flags.selectedBy ?? "agent";
      if (!["host", "agent", "human"].includes(selectedBy)) throw new Error("--selected-by must be host, agent or human.");
      const attempt = {
        host: host as "claude-code" | "codex", selected_model: model, selected_effort: effort, selected_by: selectedBy as "host" | "agent" | "human",
        started_at: new Date().toISOString(),
        ...(invocation.flags.session ? { session_sha256: digest(invocation.flags.session) } : {}),
      };
      task.attempts = [...(task.attempts ?? []), attempt];
      task.status = "running";
      run.events.push({ at: new Date().toISOString(), type: "delegation-task-started", phase: "implementation", ref: task.id, detail: `${host}:${model}:${effort}` });
      const stored = writeDelegation(projectRoot, graph);
      run.delegation!.sha256 = stored.sha256;
      writeRun(projectRoot, coreRoot, run);
      return graphResult(run, graph, `Task ${task.id} started in ${host} using host-reported model ${model} and effort ${effort}.`);
    }

    if (operation === "finish") {
      const outcome = invocation.flags.outcome;
      if (outcome !== "completed" && outcome !== "blocked" && outcome !== "failed") throw new Error("finish requires --outcome completed, blocked or failed.");
      if (task.status !== "running") throw new Error(`Task ${task.id} must be running before it can finish.`);
      const attempt = task.attempts?.at(-1);
      if (!attempt || attempt.outcome) throw new Error(`Task ${task.id} has no active execution attempt.`);
      attempt.outcome = outcome;
      attempt.finished_at = new Date().toISOString();
      const usage = readUsage(invocation.flags.usage);
      if (usage) attempt.usage = usage;
      if (outcome === "completed") {
        if (!invocation.flags.result) throw new Error("A completed task requires --result <path> containing its concise report.");
        const prefix = `.paved/generated/delegation-results/${run.id}/`;
        if (!invocation.flags.result.startsWith(prefix)) throw new Error(`Result files must be stored under ${prefix}.`);
        const resultPath = resolveSafePath(projectRoot, invocation.flags.result);
        if (!existsSync(resultPath)) throw new Error(`Task result file does not exist: ${invocation.flags.result}.`);
        task.result = { path: invocation.flags.result, sha256: digest(readFileSync(resultPath)) };
      }
      task.status = outcome;
      const type = outcome === "completed" ? "delegation-task-completed" : outcome === "blocked" ? "delegation-task-blocked" : "delegation-task-failed";
      run.events.push({ at: new Date().toISOString(), type, phase: "implementation", ref: task.id, detail: `outcome=${outcome}` });
      const stored = writeDelegation(projectRoot, graph);
      run.delegation!.sha256 = stored.sha256;
      writeRun(projectRoot, coreRoot, run);
      return graphResult(run, graph, `Task ${task.id} result recorded as host-reported ${outcome}. Inspect its changes and report before advancing implementation.`);
    }
    throw new Error(`Unknown delegation operation ${operation}.`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), "Resolve the delegation diagnostic, then repeat the operation. The approved plan and Paved workflow gates remain authoritative.");
  }
}
