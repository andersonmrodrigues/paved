import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { inspectConsumer } from "../lib/consumer-state.ts";
import { runDecisionGate, toProjection, type DecisionCandidate, type DecisionStorage } from "../lib/decisions/gate.ts";
import { decisionId, type Decision } from "../lib/decisions/record.ts";
import {
  applyClassificationAnswer, classificationCandidate, createIntentRun, IntentError, missingInputs, normalizeWorkflow, parseInputs, writeIntentDocument,
} from "../lib/intent.ts";
import { resolveSafePath } from "../lib/safe-path.ts";
import { reportNewProposals } from "../lib/gardener-report.ts";
import { reviewFor } from "../lib/review-block.ts";
import { relaysAnswers, runPhase } from "../lib/workflow-gates/index.ts";
import { now, readApproval, sha } from "../lib/workflow-gates/shared.ts";
import {
  isOpen, listRuns, loadContract, readRun, runCommand, runPath, TERMINAL_STATUSES, writeRun, type Failure, type Phase, type Run,
} from "../lib/workflow-runs.ts";
import { createDiagnostic, createResult, type CommandResult, type DecisionProjection, type Diagnostic } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { testHandler } from "./test.ts";
import { verifyHandler } from "./verify.ts";

export type Step = "intent" | "plan" | "execute";
export const STEP_PHASES: Readonly<Record<Step, readonly string[]>> = {
  intent: ["context", "discovery"],
  plan: ["planning"],
  execute: ["implementation", "validation", "verification", "evidence", "review", "completion"],
};
const STEPS = Object.keys(STEP_PHASES) as Step[];
export const ownerOf = (phase: string): Step | undefined => STEPS.find((step) => STEP_PHASES[step].includes(phase));

const answerId = (answer: string): string => answer.slice(0, answer.indexOf("="));
const RUN_HANDLERS = new Map([["run.record", { effect: "record-only" as const, apply: () => [] }]]);

function diagnostic(code: string, message: string, remediation: string): Diagnostic {
  return createDiagnostic({ severity: "error", category: "config", code, component: "workflow.runtime", message, remediation });
}

function blocked(step: Step, code: string, message: string, remediation: string, data?: Record<string, unknown>): CommandResult {
  return createResult({ command: step, status: "failed", ...(data === undefined ? {} : { data }), diagnostics: [diagnostic(code, message, remediation)] });
}

function revision(projectRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", shell: false });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : "unversioned";
}

function activePhase(run: Run): Phase | undefined {
  return run.phases.find((phase) => phase.status === "running") ?? run.phases.find((phase) => phase.status === "failed");
}

function nextStepAction(run: Run): string {
  if (TERMINAL_STATUSES.has(run.status)) return `This run is ${run.status}. Start new work with paved intent "<request>" --json.`;
  if (!run.workflow) return `Present the classification decision, then resume with paved intent --run ${run.id} --answer <id>=<value> --answered-by <you> --json.`;
  const phase = activePhase(run);
  const owner = phase === undefined ? undefined : ownerOf(phase.phase);
  if (phase === undefined || owner === undefined) return "Inspect the run; it has no active phase.";
  return `Continue ${phase.phase}, then run paved ${owner} --run ${run.id} --advance --note <observation> --json.`;
}

export function runSummary(run: Run): Record<string, unknown> {
  return {
    run: run.id, workflow: run.workflow, classification: run.classification, status: run.status,
    currentPhase: run.phases.find((phase) => phase.status === "running")?.phase,
    evidence: run.evidence,
    evidenceProduced: run.events.flatMap((event) => event.ref?.startsWith(".paved/generated/evidence/") ? [event.ref] : []),
  };
}

interface ResultExtras { readonly data?: Record<string, unknown>; readonly decisions?: readonly DecisionProjection[] }

function result(projectRoot: string, step: Step, run: Run, nextAction: string, diagnostics: readonly Diagnostic[] = [], extras: ResultExtras = {}): CommandResult {
  const failed = run.status === "failed" || run.status === "blocked" || diagnostics.some((item) => item.category !== "findings");
  const retained = failed && diagnostics.length === 0
    ? [diagnostic(run.status === "blocked" ? "PAVED_WORKFLOW_BLOCKED" : "PAVED_WORKFLOW_FAILED", run.failure?.reason ?? "Workflow cannot continue.", nextAction)]
    : [...diagnostics];
  const open = extras.decisions ?? (run.decisions ?? []).filter((item) => item.status === "ASKED").map(toProjection);
  const status = failed ? "failed" : run.status === "awaiting-input" ? "awaiting_input" : run.status === "awaiting-approval" ? "warning" : "success";
  const review = failed ? undefined : reviewFor(projectRoot, run);
  const reviewText = review === undefined ? "" : ` Open ${review.target} in the preview (${review.preview})${review.companions.length ? ` together with ${review.companions.join(", ")}` : ""} and keep paved preview wait running until the user says the review is finished; the preview approves nothing.`;
  return createResult({
    command: step, status, ...(open.length ? { decisions: open } : {}),
    data: { ...runSummary(run), ...extras.data, ...(review === undefined ? {} : { review }), nextAction: `${nextAction}${reviewText}` }, diagnostics: retained,
  });
}

function load(invocation: CommandInvocation, id: string): Run {
  const { projectRoot, coreRoot } = invocation.paths;
  const run = readRun(projectRoot, coreRoot, id);
  if (!run) throw new Error(`Workflow run ${id} does not exist.`);
  const gate = run.phases.find((phase) => phase.phase === "planning")?.gates?.find((item) => item.id === "plan-approved");
  if (gate?.status === "approved" || gate?.status === "rejected") {
    const digest = gate.reason?.replace(/^plan_sha256=/, "");
    const planRef = run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
    if (!digest || !planRef || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Workflow approval provenance is missing.");
    const planPath = resolveSafePath(projectRoot, planRef);
    if (!existsSync(planPath) || sha(readFileSync(planPath)) !== digest) throw new Error("Approved plan content has changed.");
    const decision = readApproval(projectRoot, run, digest);
    if (decision?.decision !== gate.status || decision?.decided_by !== gate.decided_by || decision?.decided_at !== gate.decided_at) {
      throw new Error("Workflow approval state does not match the human-owned approval record.");
    }
  }
  const recorded = run.events.find((event) => event.type === "evidence-recorded" && event.phase === "evidence" && event.detail?.startsWith("sha256="));
  if (recorded) {
    if (!run.evidence) throw new Error("Workflow evidence path is missing.");
    const path = resolveSafePath(projectRoot, run.evidence);
    if (!existsSync(path) || sha(readFileSync(path)) !== recorded.detail?.slice(7)) throw new Error("Workflow evidence changed after recording.");
  }
  return run;
}

function runStorage(run: Run): DecisionStorage {
  return {
    list: () => [...(run.decisions ?? [])],
    read: (id) => run.decisions?.find((decision) => decision.id === id),
    write: (decision) => {
      const next = [...(run.decisions ?? [])];
      const index = next.findIndex((item) => item.id === decision.id);
      if (index < 0) next.push(decision); else next[index] = decision;
      run.decisions = next;
    },
  };
}

function recordDecisionEvents(run: Run, before: ReadonlyMap<string, string>): void {
  for (const decision of run.decisions ?? []) {
    const previous = before.get(decision.id);
    if (previous === undefined) run.events.push({ at: now(), type: "decision-raised", ref: decision.id });
    if (previous !== "ASKED" && decision.status === "ASKED") run.events.push({ at: now(), type: "decision-asked", ref: decision.id });
    if (previous !== "ANSWERED" && decision.status === "ANSWERED") run.events.push({ at: now(), type: "decision-answered", ref: decision.id });
    if (previous !== "APPLIED" && decision.status === "APPLIED") run.events.push({ at: now(), type: "decision-applied", ref: decision.id });
    if (previous !== undefined && previous !== "SUPERSEDED" && decision.status === "SUPERSEDED") run.events.push({ at: now(), type: "decision-superseded", ref: decision.id });
  }
}

function runDecisionCandidate(decision: Decision): DecisionCandidate {
  const candidates = decision.fingerprint.inputs.filter((item) => item.startsWith("candidate:")).map((item) => item.slice("candidate:".length));
  return {
    scope: "run", question: decision.question, reason: decision.reason, options: decision.options,
    ...(decision.recommended_option === undefined ? {} : { recommended: decision.recommended_option }),
    evidence: decision.evidence, required: decision.required, requiredAnswer: decision.required_answer,
    effect: decision.effect ?? "record-only", handler: "run.record", candidates,
    ...(decision.depends_on === undefined ? {} : { dependsOn: decision.depends_on }),
  };
}

function resolveRunDecisions(invocation: CommandInvocation, run: Run, answers: readonly string[], fresh: readonly DecisionCandidate[] = []) {
  const before = new Map((run.decisions ?? []).map((decision) => [decision.id, decision.status]));
  const outcome = runDecisionGate({
    context: {
      projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
      // 1.x runs keep the command that created them, so their decision ids do not change.
      command: runCommand(run), run: run.id, answers,
      ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
    },
    providers: [() => [...(run.decisions ?? []).map(runDecisionCandidate), ...fresh]],
    handlers: RUN_HANDLERS, persist: true, storage: runStorage(run),
  });
  recordDecisionEvents(run, before);
  return outcome;
}

type Selection = { readonly run: Run; readonly answers: readonly string[] } | { readonly result: CommandResult };

const SELECT_COMMAND = "run-select";

function selectRun(invocation: CommandInvocation, step: Step): Selection {
  const { projectRoot, coreRoot } = invocation.paths;
  if (invocation.flags.run) return { run: load(invocation, invocation.flags.run), answers: invocation.flags.answers };
  const open = listRuns(projectRoot, coreRoot).filter(isOpen);
  if (open.length === 0) return { result: blocked(step, "PAVED_WORKFLOW_RUN_REQUIRED", "No open run exists.", 'Start with paved intent "<request>" --json.') };
  if (open.length === 1) return { run: load(invocation, open[0]!.id), answers: invocation.flags.answers };
  const candidate: DecisionCandidate = {
    scope: "project",
    question: "Several runs are open. Which one should Paved act on?",
    reason: "Paved never picks a run on its own.",
    options: open.map((run) => ({
      id: run.id, label: run.inputs[0]?.value ?? run.id,
      description: `${run.workflow?.id ?? "unclassified"}, ${activePhase(run)?.phase ?? "classification"}.`,
      consequence: `paved ${step} acts on ${run.id}.`,
    })),
    evidence: open.map((run) => ({ type: "file" as const, location: `.paved/generated/runs/${run.id}.yaml`, sha256: sha(readFileSync(runPath(projectRoot, run.id))) })),
    required: true, requiredAnswer: { type: "single-choice" },
    effect: "record-only", handler: "run.select", candidates: open.map((run) => run.id),
  };
  // One selection scope for every step, so the answer can be given to whichever step continues.
  const id = decisionId(candidate.question, `project:${SELECT_COMMAND}`, candidate.candidates);
  const own = invocation.flags.answers.filter((answer) => answerId(answer) === id);
  const decisions: Decision[] = [];
  const outcome = runDecisionGate({
    context: { projectRoot, coreRoot, command: SELECT_COMMAND, answers: own, ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }) },
    providers: [() => [candidate]],
    handlers: new Map([["run.select", { effect: "record-only" as const, apply: () => [] }]]),
    // The choice is per invocation; nothing about it is stored.
    persist: true,
    storage: {
      list: () => [...decisions],
      read: (decisionIdValue) => decisions.find((decision) => decision.id === decisionIdValue),
      write: (decision) => { const index = decisions.findIndex((item) => item.id === decision.id); if (index < 0) decisions.push(decision); else decisions[index] = decision; },
    },
  });
  if (outcome.problems.length) return { result: blocked(step, "PAVED_DECISION_ANSWER_INVALID", outcome.problems.join("; "), "Answer with one of the listed run ids.") };
  const chosen = outcome.applied.find((decision) => decision.id === id)?.answer;
  if (typeof chosen !== "string") {
    return { result: createResult({ command: step, status: "awaiting_input", decisions: outcome.projections, data: {
      nextAction: `Ask the user which run to continue, then repeat paved ${step} with --answer ${id}=<run-id> --answered-by <you>, or pass --run <id>.`,
    } }) };
  }
  return { run: load(invocation, chosen), answers: invocation.flags.answers.filter((answer) => answerId(answer) !== id) };
}

function startIntent(invocation: CommandInvocation): CommandResult {
  const { projectRoot, coreRoot } = invocation.paths;
  const flags = invocation.flags;
  const lifecycle = inspectConsumer({ projectRoot, coreRoot }).lifecycleState;
  if (!["RESOLVED", "GENERATED", "VALIDATED", "READY"].includes(lifecycle)) {
    return blocked("intent", "PAVED_WORKFLOW_LIFECYCLE_BLOCKED", `Cannot start work in lifecycle state ${lifecycle}.`, "Run paved status and resolve the reported state first.");
  }
  const run = createIntentRun(projectRoot, coreRoot, {
    request: invocation.selectors.join(" "), parts: flags.parts, inputs: flags.intentInputs,
    ...(flags.workflow === undefined ? {} : { workflow: flags.workflow }),
    ...(flags.recommend === undefined ? {} : { recommend: flags.recommend }),
    ...(flags.because === undefined ? {} : { because: flags.because }),
  }, revision(projectRoot));
  if (existsSync(runPath(projectRoot, run.id))) {
    const existing = load(invocation, run.id);
    return result(projectRoot, "intent", existing, nextStepAction(existing));
  }
  writeIntentDocument(projectRoot, run);
  if (run.workflow) {
    writeRun(projectRoot, coreRoot, run);
    return result(projectRoot, "intent", run, nextStepAction(run));
  }
  const recommend = flags.recommend === undefined ? undefined : normalizeWorkflow(projectRoot, coreRoot, flags.recommend);
  resolveRunDecisions(invocation, run, [], [classificationCandidate(projectRoot, coreRoot, run, recommend, flags.because)]);
  writeRun(projectRoot, coreRoot, run);
  return result(projectRoot, "intent", run, `Present the classification decision to the user, then resume with paved intent --run ${run.id} --answer <id>=<value> --answered-by <you> --json.`);
}

function finishClassification(invocation: CommandInvocation, run: Run): CommandResult {
  const { projectRoot, coreRoot } = invocation.paths;
  const decision = run.decisions?.[0];
  if (decision?.status !== "APPLIED") return result(projectRoot, "intent", run, nextStepAction(run));
  const outcome = applyClassificationAnswer(projectRoot, coreRoot, run, decision);
  if (outcome.split) {
    writeRun(projectRoot, coreRoot, run);
    writeIntentDocument(projectRoot, run);
    const commands = outcome.split.map((part) => `paved intent ${JSON.stringify(part)} --json`).join("; ");
    return result(projectRoot, "intent", run, `The request was split. Start each part on its own: ${commands}.`);
  }
  run.inputs.push(...parseInputs(coreRoot, run.workflow!.id, invocation.flags.intentInputs));
  const missing = missingInputs(coreRoot, run.workflow!.id, run.inputs);
  if (missing.length) {
    return blocked("intent", "PAVED_WORKFLOW_INPUT_MISSING", `${run.workflow!.id} requires: ${missing.join(", ")}.`, `Ask the user, then resume with paved intent --run ${run.id} --answer ${decision.id}=${String(decision.answer)} --input ${missing[0]}=<value> --json.`, { run: run.id });
  }
  writeRun(projectRoot, coreRoot, run);
  writeIntentDocument(projectRoot, run);
  return result(projectRoot, "intent", run, `Classified as ${run.workflow!.id}. ${nextStepAction(run)}`);
}

function evidencePath(invocation: CommandInvocation): string | undefined {
  if (!invocation.flags.evidence) return undefined;
  const path = resolveSafePath(invocation.paths.projectRoot, invocation.flags.evidence);
  if (!existsSync(path)) throw new Error(`Evidence file does not exist: ${invocation.flags.evidence}`);
  return path;
}

function completeAndStartNext(run: Run, phase: Phase): void {
  phase.status = "completed";
  run.events.push({ at: now(), type: "phase-completed", phase: phase.phase });
  const next = run.phases[run.phases.indexOf(phase) + 1];
  if (next) {
    next.status = "running"; next.attempts = (next.attempts ?? 0) + 1;
    run.events.push({ at: now(), type: "phase-started", phase: next.phase });
  } else {
    run.status = "completed"; run.ended_at = now();
    run.events.push({ at: now(), type: "run-completed" });
  }
}

function failRun(run: Run, phase: Phase, reason: string, nextAction: string): void {
  const failure: Failure = { code: "verification-failed", phase: phase.phase, reason, retry: "retryable", next_action: nextAction };
  phase.status = "failed"; phase.failure = failure; run.failure = failure;
  run.status = "failed"; run.ended_at = now();
  run.events.push({ at: now(), type: "phase-failed", phase: phase.phase, detail: reason }, { at: now(), type: "run-failed", phase: phase.phase });
}

function planApproved(run: Run): boolean {
  return run.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.id === "plan-approved")?.status === "approved";
}

async function resume(invocation: CommandInvocation, step: Step, run: Run, answers: readonly string[]): Promise<CommandResult> {
  const { projectRoot, coreRoot } = invocation.paths;
  if (TERMINAL_STATUSES.has(run.status)) return result(projectRoot, step, run, nextStepAction(run));
  const current = run.workflow ? activePhase(run) : undefined;
  const owner: Step | undefined = run.workflow ? (current ? ownerOf(current.phase) : undefined) : "intent";
  if (step === "execute" && run.workflow && !planApproved(run)) {
    return blocked(step, "PAVED_WORKFLOW_PLAN_UNAPPROVED", `Run ${run.id} has no approved plan.`, nextStepAction(run), { run: run.id });
  }
  if (owner !== step) {
    return blocked(step, "PAVED_WORKFLOW_STEP_OUT_OF_RANGE", `Run ${run.id} is in ${current?.phase ?? "classification"}, which paved ${owner ?? "<none>"} owns.`, nextStepAction(run), { run: run.id, currentPhase: current?.phase, owner });
  }
  const runIds = new Set((run.decisions ?? []).map((decision) => decision.id));
  const runAnswers = answers.filter((answer) => runIds.has(answerId(answer)));
  const toolAnswers = answers.filter((answer) => !runIds.has(answerId(answer)));
  if (!run.workflow && toolAnswers.length > 0) {
    return blocked(step, "PAVED_DECISION_ANSWER_INVALID", `No open decision of run ${run.id} has id ${answerId(toolAnswers[0]!)}.`, "Answer the classification decision with one of its offered options.", { run: run.id });
  }
  const decisions = resolveRunDecisions(invocation, run, runAnswers);
  if (decisions.problems.length > 0) {
    return blocked(step, "PAVED_DECISION_ANSWER_INVALID", decisions.problems.join("; "), "Answer an open run decision with one of its offered options.", { run: run.id });
  }
  if (!run.workflow) {
    if (decisions.status === "awaiting-input") { writeRun(projectRoot, coreRoot, run); return result(projectRoot, step, run, nextStepAction(run)); }
    return finishClassification(invocation, run);
  }
  if (decisions.status === "awaiting-input") {
    run.status = "awaiting-input";
    writeRun(projectRoot, coreRoot, run);
    return result(projectRoot, step, run, `Answer the run decision, then resume with paved ${step} --run ${run.id} --advance --answer <id>=<value> --answered-by <you> --json.`);
  }
  if (run.status === "awaiting-input") run.status = "running";
  if (decisions.applied.length > 0) writeRun(projectRoot, coreRoot, run);
  const phase = current!;
  const approvalPending = phase.gates?.some((gate) => gate.id === "plan-approved" && gate.status === "awaiting-approval") === true;
  const relays = relaysAnswers(run.workflow.id, phase.phase);
  // Answers for the testing Tool or verification are passed to them; while a plan awaits approval stray answers are ignored, as in 1.x.
  if (toolAnswers.length > 0 && !relays && !approvalPending) {
    return blocked(step, "PAVED_DECISION_ANSWER_INVALID", `No open decision of run ${run.id} has id ${answerId(toolAnswers[0]!)}.`, "Answer an open decision with one of its offered options.", { run: run.id });
  }
  if (!invocation.flags.advance && !invocation.flags.approve) return result(projectRoot, step, run, nextStepAction(run));

  const workflow = loadContract(coreRoot, run.workflow.id);
  if (phase.status === "failed") {
    const contractPhase = workflow.phases.find((item) => item.phase === phase.phase);
    const retryLimit = contractPhase?.retry?.class === "non-retryable" ? 1 : (contractPhase?.retry?.max_attempts ?? 2);
    if ((phase.attempts ?? 0) >= retryLimit) return blocked(step, "PAVED_WORKFLOW_RETRIES_EXHAUSTED", `${phase.phase} exhausted its ${retryLimit} attempts.`, "A human must inspect the failure and start a new run or change the approved plan.");
    phase.status = "running"; delete phase.failure; delete run.failure; delete run.ended_at; run.status = "running";
    phase.attempts = (phase.attempts ?? 0) + 1;
    run.events.push({ at: now(), type: "retry-started", phase: phase.phase });
  }
  const forwarded: CommandInvocation = { ...invocation, flags: { ...invocation.flags, answers: relays ? toolAnswers : [] } };
  const note = invocation.flags.note?.trim();
  const evidence = evidencePath(invocation);
  const outcome = await runPhase({
    projectRoot, coreRoot, run, phase, workflow, approve: invocation.flags.approve === true,
    tools: {
      test: async () => testHandler({ ...forwarded, command: "test" }),
      verify: async () => verifyHandler({ ...forwarded, command: "verify" }),
    },
    ...(note ? { note } : {}), ...(evidence ? { evidence } : {}),
  });
  switch (outcome.kind) {
    case "blocked":
      if (decisions.applied.length > 0) writeRun(projectRoot, coreRoot, run);
      return blocked(step, outcome.code, outcome.message, outcome.remediation, { run: run.id });
    case "relay":
      return createResult({
        command: step, status: "awaiting_input", decisions: outcome.result.decisions ?? [],
        data: { ...runSummary(run), relayedFrom: outcome.result.command, nextAction: `Present the ${outcome.result.command} decision, then repeat paved ${step} --run ${run.id} --advance with the same flags plus --answer <id>=<value> --answered-by <you> --json.` },
        diagnostics: outcome.result.diagnostics,
      });
    case "fail":
      failRun(run, phase, outcome.reason, outcome.nextAction);
      writeRun(projectRoot, coreRoot, run);
      return result(projectRoot, step, run, outcome.nextAction, outcome.diagnostics);
    case "wait":
      writeRun(projectRoot, coreRoot, run);
      return result(projectRoot, step, run, outcome.nextAction);
    case "pass": {
      completeAndStartNext(run, phase);
      writeRun(projectRoot, coreRoot, run);
      if (run.status !== "completed") return result(projectRoot, step, run, nextStepAction(run));
      // Advisory only: a gardener failure or proposal never changes the outcome.
      const gardener = reportNewProposals(projectRoot, coreRoot);
      return result(projectRoot, step, run, "Workflow complete with authoritative verification evidence.", [], Object.keys(gardener).length > 0 ? { data: { gardener } } : {});
    }
  }
}

export async function stepHandler(invocation: CommandInvocation): Promise<CommandResult> {
  const step = invocation.command as Step;
  try {
    if (step === "intent" && !invocation.flags.run && invocation.selectors.length > 0) return startIntent(invocation);
    const selected = selectRun(invocation, step);
    if ("result" in selected) return selected.result;
    return await resume(invocation, step, selected.run, selected.answers);
  } catch (error) {
    if (error instanceof IntentError) return blocked(step, error.code, error.message, error.remediation);
    return blocked(step, "PAVED_WORKFLOW_STATE_INVALID", error instanceof Error ? error.message : "Workflow failed.", "Inspect the workflow run and correct its state before retrying.");
  }
}
