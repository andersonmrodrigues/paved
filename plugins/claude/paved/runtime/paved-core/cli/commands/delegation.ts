import { existsSync, readFileSync } from "node:fs";
import { loadYaml } from "../lib/documents.ts";
import { resolveConsumerPath, resolveSafePath } from "../lib/safe-path.ts";
import { readRun, runBelongsTo, runSourceRoot, writeRun, type Run } from "../lib/workflow-runs.ts";
import { approvedPlanDigest, approveDelegation, changedSinceSnapshot, delegationSpecDigest, digest, readDelegation, readyTasks, validateDelegationPlan, workspaceSnapshot, writeDelegation, type DelegationPlan, type DelegationTask, type DelegationAttempt } from "../lib/delegation.ts";
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

function outsideWriteScope(task: DelegationTask, changedPaths: readonly string[]): string[] {
  return changedPaths.filter((changedPath) => !task.write_paths.some((scope) => changedPath === scope || changedPath.startsWith(`${scope.replace(/\/$/, "")}/`)));
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
  if (!operation || invocation.selectors.length !== 1) return failure("Choose one operation: plan, approve, ready, start, finish, recover or capabilities.", "Run paved delegation --help to see the operation and its required flags.");
  if (operation === "capabilities") {
    const host = invocation.flags.host;
    if (host !== "claude-code" && host !== "codex") return failure("capabilities requires --host codex or --host claude-code.", "Pass the host you are currently using.");
    return createResult({ command: "delegation", status: "success", data: { host, nativeSessions: "host-managed", modelSelection: host === "claude-code" ? "per-subagent model and effort controls; inspect host catalog" : "host-dependent; may inherit parent model", isolation: "use host-native isolated worktrees for parallel writers when available", permissionBoundary: "Paved records task scopes; host permissions remain authoritative" } });
  }
  if (!runId) return failure("--run is required.", "Pass the current workflow run id.");
  try {
    const run = readRun(projectRoot, coreRoot, runId);
    if (!run) throw new Error(`Workflow run ${runId} does not exist.`);
    if (!runBelongsTo(projectRoot, run, invocation.paths.sourceRoot)) throw new Error(`Workflow run ${runId} works on the checkout at ${runSourceRoot(projectRoot, run)}; continue it from there.`);
    const planSha = requireImplementation(run);

    if (operation === "plan") {
      if (!invocation.flags.file) throw new Error("plan requires --file <path>.");
      if (run.delegation) throw new Error("A delegation graph is already registered. Amend the approved plan before replacing it.");
      const inputPath = resolveConsumerPath(projectRoot, invocation.paths.sourceRoot, invocation.flags.file);
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
    if (operation === "approve") {
      if (!invocation.flags.approve) throw new Error("After showing this exact graph to the user and receiving approval, pass --approve.");
      if (graph.tasks.some((item) => item.status === "running" || item.attempts?.length)) throw new Error("A graph can only be approved before any task starts.");
      const approval = approveDelegation(projectRoot, run, graph);
      run.delegation!.approval = approval;
      run.events.push({ at: new Date().toISOString(), type: "delegation-task-approved", phase: "implementation", ref: approval.graph_sha256, detail: `decided_by=${approval.decided_by}` });
      writeRun(projectRoot, coreRoot, run);
      return graphResult(run, graph, `Exact graph ${approval.graph_sha256} approved. Ready tasks may now start.`);
    }
    if (operation === "ready") return graphResult(run, graph, "Use the host's native agent/session tools. A delegated result is not verification; inspect changes and run the required checks in the primary session.");

    const task = graph.tasks.find((item) => item.id === invocation.flags.task);
    if (!task) throw new Error("Pass --task with an id from this delegation graph.");
    if (operation === "start") {
      if (!run.delegation?.approval || run.delegation.approval.graph_sha256 !== delegationSpecDigest(graph)) throw new Error("This exact delegation graph has not been explicitly approved by the user.");
      if (task.experiment && invocation.flags.isolation !== "isolated-worktree") throw new Error(`Experiment task ${task.id} must use --isolation isolated-worktree so candidates cannot contaminate one another.`);
      const { host, model, effort } = invocation.flags;
      if (host !== "codex" && host !== "claude-code") throw new Error("start requires --host codex or --host claude-code.");
      if (!model || !effort) throw new Error("start requires the actual --model and --effort selected by the host.");
      const isolation = invocation.flags.isolation;
      if (isolation !== "shared-workspace" && isolation !== "isolated-worktree") throw new Error("start requires --isolation shared-workspace or isolated-worktree.");
      if (task.status !== undefined && task.status !== "pending" && task.status !== "failed") throw new Error(`Task ${task.id} is ${task.status}; only pending or failed tasks may start.`);
      for (const previous of task.attempts ?? []) {
        const unresolved = previous.scope_violations ?? [];
        if (previous.workspace_snapshot && unresolved.some((path) => changedSinceSnapshot(invocation.paths.sourceRoot, previous.workspace_snapshot!).includes(path))) {
          throw new Error(`Task ${task.id} cannot retry while out-of-scope paths remain changed: ${unresolved.join(", ")}. Restore them to their pre-attempt contents first.`);
        }
      }
      if (!readyTasks(graph).some((item) => item.id === task.id)) throw new Error(`Task ${task.id} is not ready; complete its dependencies first.`);
      if (graph.tasks.filter(active).length >= graph.max_concurrency) throw new Error(`Delegation concurrency limit ${graph.max_concurrency} has been reached.`);
      noWriteConflict(graph, task);
      if (isolation === "shared-workspace" && graph.tasks.some((item) => item.status === "running" && (item.write_paths.length > 0 || task.write_paths.length > 0))) throw new Error("Shared-workspace editing is serialized; finish the active writer first or use host-native isolated worktrees.");
      const selectedBy = invocation.flags.selectedBy ?? "agent";
      if (!["host", "agent", "human"].includes(selectedBy)) throw new Error("--selected-by must be host, agent or human.");
      const attempt = {
        host: host as "claude-code" | "codex", selected_model: model, selected_effort: effort, selected_by: selectedBy as "host" | "agent" | "human",
        started_at: new Date().toISOString(), isolation: isolation as "shared-workspace" | "isolated-worktree",
        ...(isolation === "shared-workspace" ? { workspace_snapshot: workspaceSnapshot(invocation.paths.sourceRoot) } : {}),
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

    if (operation === "recover") {
      if (task.status !== "running") throw new Error(`Task ${task.id} is not running.`);
      if (!invocation.flags.confirmedStopped || !invocation.flags.note?.trim()) throw new Error("recover requires --confirmed-stopped and --note <reason> after confirming the native session has stopped.");
      const attempt = task.attempts?.at(-1);
      if (!attempt || attempt.outcome) throw new Error(`Task ${task.id} has no active execution attempt.`);
      if (attempt.isolation === "shared-workspace" && attempt.workspace_snapshot) {
        attempt.changed_paths = changedSinceSnapshot(invocation.paths.sourceRoot, attempt.workspace_snapshot);
        attempt.scope_violations = outsideWriteScope(task, attempt.changed_paths);
      }
      attempt.outcome = "failed"; attempt.finished_at = new Date().toISOString(); attempt.recovery_reason = invocation.flags.note;
      task.status = "failed";
      run.events.push({ at: new Date().toISOString(), type: "delegation-task-recovered", phase: "implementation", ref: task.id, detail: invocation.flags.note });
      const stored = writeDelegation(projectRoot, graph); run.delegation!.sha256 = stored.sha256;
      writeRun(projectRoot, coreRoot, run);
      return graphResult(run, graph, `Task ${task.id} recovered as failed; a retry can start after reapproving the updated graph.`);
    }

    if (operation === "finish") {
      const outcome = invocation.flags.outcome;
      if (outcome !== "completed" && outcome !== "blocked" && outcome !== "failed") throw new Error("finish requires --outcome completed, blocked or failed.");
      if (task.status !== "running") throw new Error(`Task ${task.id} must be running before it can finish.`);
      const attempt = task.attempts?.at(-1);
      if (!attempt || attempt.outcome) throw new Error(`Task ${task.id} has no active execution attempt.`);
      const usage = readUsage(invocation.flags.usage);
      if (usage) attempt.usage = usage;
      const reportedPaths = invocation.flags.changedPaths ?? [];
      const observedPaths = attempt.isolation === "shared-workspace" && attempt.workspace_snapshot
        ? changedSinceSnapshot(invocation.paths.sourceRoot, attempt.workspace_snapshot) : [...reportedPaths];
      if (outcome === "completed" && attempt.isolation === "isolated-worktree" && !reportedPaths.length) throw new Error("isolated-worktree completion requires repeatable --changed-path reports.");
      if (outcome === "completed" && attempt.isolation === "shared-workspace" && reportedPaths.some((path) => !observedPaths.includes(path))) throw new Error("A host-reported changed path was not observed in the shared workspace snapshot.");
      attempt.changed_paths = observedPaths;
      attempt.scope_violations = outsideWriteScope(task, observedPaths);
      if (outcome === "completed") {
        if (!invocation.flags.result) throw new Error("A completed task requires --result <path> containing its concise report.");
        const prefix = `.paved/generated/delegation-results/${run.id}/`;
        if (!invocation.flags.result.startsWith(prefix)) throw new Error(`Result files must be stored under ${prefix}.`);
        const resultPath = resolveSafePath(projectRoot, invocation.flags.result);
        if (!existsSync(resultPath)) throw new Error(`Task result file does not exist: ${invocation.flags.result}.`);
        task.result = { path: invocation.flags.result, sha256: digest(readFileSync(resultPath)) };
        if (attempt.scope_violations.length) {
          attempt.outcome = "failed"; attempt.finished_at = new Date().toISOString(); task.status = "failed";
          run.events.push({ at: new Date().toISOString(), type: "delegation-task-failed", phase: "implementation", ref: task.id, detail: `scope_violations=${attempt.scope_violations.join(",")}` });
          const stored = writeDelegation(projectRoot, graph); run.delegation!.sha256 = stored.sha256; writeRun(projectRoot, coreRoot, run);
          return failure(`Task ${task.id} changed files outside its declared write_paths: ${attempt.scope_violations.join(", ")}.`, "Restore each out-of-scope path to its pre-attempt contents before retrying. The attempt remains recorded as failed.");
        }
        task.changed_paths = observedPaths;
      }
      attempt.outcome = outcome;
      attempt.finished_at = new Date().toISOString();
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
