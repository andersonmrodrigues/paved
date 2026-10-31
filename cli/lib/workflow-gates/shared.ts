import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.ts";
import { loadYaml } from "../documents.ts";
import { evaluateCompletion, loadEvidenceRegistry, type EvidenceRecord } from "../evidence.ts";
import { discoverSources } from "../generator-runtime.ts";
import { localApprover } from "../local-identity.ts";
import { resolveSafePath } from "../safe-path.ts";
import { createRegistry } from "../schemas.ts";
import { ENVIRONMENT_UNAVAILABLE, isTestingToolEvidence, type TestToolOutcome } from "../test-runner.ts";
import { sanitizeToolOutput } from "../tools.ts";
import { writeWorkflowEvidence } from "../workflow-evidence.ts";
import { assessWorkflowEvidence, UNCHANGED_HANDLER } from "../workflows.ts";
import { runSourceRoot, type Run } from "../workflow-runs.ts";
import { createDiagnostic, type Diagnostic } from "../../result.ts";
import { previewTarget } from "../preview-review.ts";
import { stopPreview } from "../preview-server.ts";
import type { PhaseContext, PhaseHook, PhaseOutcome } from "./index.ts";

export const SHARED_GATES = ["plan-approved", "criteria-met"] as const;

export const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const now = (): string => new Date().toISOString();
export const projectRelative = (root: string, path: string): string => relative(realpathSync(root), realpathSync(path)).split(sep).join("/");

export function blocked(code: string, message: string, remediation: string): PhaseOutcome {
  return { kind: "blocked", code, message, remediation };
}

/** Digest of the project's source and test files, recorded when the run starts. */
export function fingerprint(projectRoot: string): string {
  return sha(JSON.stringify(discoverSources(projectRoot)
    .filter((source) => source.kind === "source-module" || source.kind === "test")
    .map((source) => [source.path, source.sha256])));
}

const VERIFIED_SOURCE = "source_sha256=";

/**
 * True when a completed run's source and test files differ from what its verification saw,
 * so the recorded evidence no longer describes the code. Runs from before the digest was
 * recorded are never reported.
 */
export function changedSinceVerification(projectRoot: string, run: Run): boolean {
  if (run.status !== "completed") return false;
  const recorded = run.events.findLast((event) => event.type === "verification-executed" && event.detail?.startsWith(VERIFIED_SOURCE))?.detail;
  if (recorded === undefined) return false;
  return fingerprint(runSourceRoot(projectRoot, run)) !== recorded.slice(VERIFIED_SOURCE.length);
}

export function recordObservation(context: PhaseContext, ref?: string): void {
  const location = ref ?? (context.evidence ? projectRelative(context.projectRoot, context.evidence) : undefined);
  context.run.events.push({
    at: now(), type: "evidence-recorded", phase: context.phase.phase,
    ...(location ? { ref: location } : {}),
    detail: String(sanitizeToolOutput(context.note ?? "")).slice(0, 4000),
  });
}

/** Sends a run back to implementation, so everything after it runs again on the new change. */
export function reopenImplementation(run: Run, reason: string): void {
  const start = run.phases.findIndex((phase) => phase.phase === "implementation");
  if (start < 0 || run.phases.slice(start + 1).every((phase) => phase.status === "pending")) return;
  for (const phase of run.phases.slice(start)) {
    if (phase.status === "pending") continue;
    phase.status = "pending"; delete phase.gates; delete phase.failure;
    run.events.push({ at: now(), type: "phase-reopened", phase: phase.phase, detail: reason });
  }
  const implementation = run.phases[start]!;
  implementation.status = "running"; implementation.attempts = (implementation.attempts ?? 0) + 1;
  run.events.push({ at: now(), type: "phase-started", phase: implementation.phase });
}

const UNCHANGED_QUESTION = "No source or test file changed since the run started. Is the approved work already in the repository?";

/** True while the source and test files match the fingerprint recorded when the run started. */
export function sourceUnchanged(projectRoot: string, run: Run): boolean {
  const started = run.events.find((event) => event.type === "run-started")?.detail?.replace(/^source_sha256=/, "");
  return started !== undefined && fingerprint(runSourceRoot(projectRoot, run)) === started;
}

/** Implementation needs a change, unless the user confirms the approved work already exists; verification still has to prove it. */
export function implementationChanged(context: PhaseContext): PhaseOutcome | undefined {
  const { run, projectRoot } = context;
  if (!sourceUnchanged(projectRoot, run)) return undefined;
  const answered = run.decisions?.find((decision) => decision.handler === UNCHANGED_HANDLER && decision.status === "APPLIED");
  if (answered?.answer === "already-done") return undefined;
  if (answered) return blocked("PAVED_WORKFLOW_CHANGE_MISSING", "No source or test change was observed after approval.", "Implement the approved change before advancing.");
  const planRef = run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
  return {
    kind: "ask",
    nextAction: `Ask the user, then resume with paved execute --run ${run.id} --advance --note <observation> --answer <id>=<value> --answered-by <you> --json.`,
    candidate: {
      scope: "run", question: UNCHANGED_QUESTION,
      reason: "Paved proves a change by observing it. Work done before the run started can still be accepted, and validation and verification must then pass on it.",
      options: [
        { id: "already-done", label: "Already done", description: "The approved change is already in the repository.", consequence: "Implementation passes and validation and verification check the existing code." },
        { id: "keep-working", label: "Not yet", description: "The change still has to be made.", consequence: "Implementation stays open until a source or test file changes." },
      ],
      evidence: planRef ? [{ type: "file", location: planRef, sha256: sha(readFileSync(resolveSafePath(projectRoot, planRef))) }] : [],
      required: true, requiredAnswer: { type: "single-choice" }, effect: "record-only", handler: UNCHANGED_HANDLER,
      candidates: ["already-done", "keep-working"],
    },
  };
}

export function failedTestingEvidence(roots: { projectRoot: string; coreRoot: string }, path: string, run: Run): boolean {
  const rel = projectRelative(roots.projectRoot, path);
  if (!rel.startsWith(".paved/generated/evidence/") || !rel.endsWith(".yaml")) return false;
  const raw = loadYaml(path) as Record<string, unknown>;
  const validation = createRegistry(join(roots.coreRoot, "schemas"), ["paved/v1"]).validate(raw);
  if (!validation.valid) return false;
  const record = raw as unknown as EvidenceRecord & { created_at?: string; producer?: { agent?: string }; change?: { summary?: string; revision?: string } };
  if (!isTestingToolEvidence(record)
    || record.change.revision !== run.revision || !record.created_at || Date.parse(record.created_at) < Date.parse(run.started_at)) return false;
  const source = (raw.artifacts as { source?: { type?: string; location?: string; sha256?: string } }[] | undefined)?.[0]?.source;
  if (source?.type !== "file" || !source.location?.startsWith(".paved/generated/evidence/") || !source.sha256) return false;
  const logPath = resolveSafePath(roots.projectRoot, source.location);
  if (!existsSync(logPath)) return false;
  const log = readFileSync(logPath, "utf8");
  if (sha(log) !== source.sha256) return false;
  const line = log.split("\n").find((entry) => entry.startsWith("tool_result_json: "));
  if (!line) return false;
  try {
    const execution = JSON.parse(line.slice("tool_result_json: ".length)) as { status?: string; error_code?: string; exit_code?: number };
    return execution.status === "failed" && execution.error_code === "execution-failure" && typeof execution.exit_code === "number" && execution.exit_code > 0;
  } catch { return false; }
}

export interface ApprovalRecord { decision: "approved" | "rejected"; decided_by: string; decided_at: string }

export function readApproval(projectRoot: string, run: Run, planSha: string): ApprovalRecord | undefined {
  const path = resolveSafePath(projectRoot, `.paved/approvals/${run.id}.json`);
  if (!existsSync(path)) return undefined;
  const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (document.plan_sha256 !== planSha) return undefined;
  if (document.run !== run.id || !["approved", "rejected"].includes(String(document.decision))
    || typeof document.decided_by !== "string" || !document.decided_by.trim() || ["agent", "paved", "ci"].includes(document.decided_by)
    || typeof document.decided_at !== "string" || Number.isNaN(Date.parse(document.decided_at))) {
    throw new Error("Approval record is invalid or does not match the current plan. A human must decide the exact plan in .paved/approvals/<run-id>.json.");
  }
  return { decision: document.decision as ApprovalRecord["decision"], decided_by: document.decided_by, decided_at: document.decided_at };
}

// The user approves in the conversation; this records that decision for the exact plan version shown.
function recordApproval(projectRoot: string, run: Run, planSha: string): void {
  const path = resolveSafePath(projectRoot, `.paved/approvals/${run.id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify({ run: run.id, plan_sha256: planSha, decision: "approved",
    decided_by: localApprover(), decided_at: now() }, null, 2)}\n`);
}

const BASELINE = "baseline status=";

export function testOutcomes(result: { data?: unknown }): readonly TestToolOutcome[] {
  return (result.data as { outcomes?: readonly TestToolOutcome[] } | undefined)?.outcomes ?? [];
}

const describeTools = (outcomes: readonly TestToolOutcome[]): string =>
  outcomes.map((item) => `${item.tool} in ${item.workingDirectory}${item.evidence ? ` (${item.evidence})` : ""}`).join("; ");

/**
 * Runs the testing Tool once when the plan is approved and nothing has changed yet, so a
 * later validation failure can be told apart from tests that were already failing.
 * A baseline that cannot run is skipped; it never blocks the approval, but a failing one
 * is reported right away instead of surfacing only after the change is implemented.
 */
async function recordBaseline(context: PhaseContext): Promise<Diagnostic[]> {
  const { run, projectRoot } = context;
  if (run.events.some((event) => event.type === "tool-invoked") || !sourceUnchanged(projectRoot, run)) return [];
  const tested = await context.tools.test();
  const ref = (tested.data as { evidence?: string } | undefined)?.evidence;
  if (tested.status === "awaiting_input" || ref === undefined) return [];
  const outcome = tested.status === "success" ? "passed" : environmentProblem(tested.diagnostics) ? "environment-unavailable" : "failed";
  const outcomes = testOutcomes(tested);
  const failing = outcomes.filter((item) => item.status === "failed").map((item) => item.tool);
  const unavailable = outcomes.filter((item) => item.status === "environment-unavailable").map((item) => item.tool);
  const detail = [`${BASELINE}${outcome}`, ...(failing.length ? [`failing=${failing.join(",")}`] : []),
    ...(unavailable.length ? [`unavailable=${unavailable.join(",")}`] : [])].join("; ");
  run.events.push({ at: now(), type: "tool-invoked", phase: "planning", ref, detail });
  if (outcome === "passed") return [];
  const broken = outcomes.filter((item) => item.status !== "passed");
  const which = broken.length > 0 ? describeTools(broken) : ref;
  return [createDiagnostic({
    severity: "info", category: "findings", code: "PAVED_WORKFLOW_BASELINE_FAILING", component: "workflow.runtime",
    message: outcome === "failed"
      ? `The tests already fail before any change: ${which}. Validation requires them to pass, so this run cannot complete until they do.`
      : `The tests cannot reach their environment before any change: ${which}. Validation blocks until they can.`,
    remediation: "Tell the user now, before implementing: either include fixing these tests in the plan (paved plan --amend), "
      + "or exclude the tests that cannot pass here from the testing Tool, or make their environment available.",
  })];
}

export interface Baseline {
  readonly outcome: string;
  readonly ref?: string;
  /** Tools that failed at approval; empty when the baseline predates per-Tool recording. */
  readonly failing: readonly string[];
}

/** The baseline recorded at plan approval, when one ran. */
export function baseline(run: Run): Baseline | undefined {
  const event = run.events.find((item) => item.type === "tool-invoked" && item.phase === "planning" && item.detail?.startsWith(BASELINE));
  if (event === undefined) return undefined;
  const [status, ...fields] = event.detail!.slice(BASELINE.length).split("; ");
  const failing = fields.find((field) => field.startsWith("failing="))?.slice("failing=".length).split(",").filter(Boolean) ?? [];
  return { outcome: status!, failing, ...(event.ref === undefined ? {} : { ref: event.ref }) };
}

// The testing Tool could not reach what it needs; neither a regression nor a setup mistake.
const ENVIRONMENT_CODES: ReadonlySet<string> = new Set([ENVIRONMENT_UNAVAILABLE, "PAVED_TEST_LAUNCH_FAILED"]);

function environmentProblem(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  return diagnostics.find((item) => ENVIRONMENT_CODES.has(item.code));
}

/** Blocks without spending an attempt when the tests could not run against their environment. */
export function environmentBlocked(diagnostics: readonly Diagnostic[]): PhaseOutcome | undefined {
  const problem = environmentProblem(diagnostics);
  if (problem === undefined) return undefined;
  return blocked("PAVED_WORKFLOW_ENVIRONMENT_UNAVAILABLE", `${problem.message} This is not attributed to the change.`,
    `${problem.remediation ?? "Make the test environment available."} Advance again afterwards; an unavailable environment does not consume a phase attempt.`);
}

/** An approved plan takes no more comments, so its preview stops instead of waiting on nobody. */
async function closePlanPreview(context: PhaseContext): Promise<void> {
  const planRef = context.run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
  if (planRef === undefined) return;
  try {
    await stopPreview(context.projectRoot, previewTarget(context.projectRoot, planRef).relative);
  } catch { /* A preview that cannot be reached is already closed for the reviewer. */ }
}

const planning: PhaseHook = async (context) => {
  const outcome = approvePlan(context);
  if (outcome.kind !== "pass") return outcome;
  await closePlanPreview(context);
  const warnings = await recordBaseline(context);
  return warnings.length > 0 ? { ...outcome, warnings } : outcome;
};

function approvePlan(context: PhaseContext): PhaseOutcome {
  const { run, phase, projectRoot } = context;
  const gate = phase.gates?.find((item) => item.id === "plan-approved");
  if (!gate) {
    if (context.approve) return blocked("PAVED_WORKFLOW_APPROVAL_NOT_REQUESTED", "No plan awaits approval in this run.", `Request approval first with paved plan --run ${run.id} --advance --evidence <plan-path> --note <summary> --json.`);
    if (!context.evidence || !context.note) return blocked("PAVED_WORKFLOW_PLAN_REQUIRED", "A concrete plan file and summary are required before approval.", `Run paved plan --run ${run.id} --advance --evidence <plan-path> --note <summary> --json.`);
    const planSha = sha(readFileSync(context.evidence));
    phase.gates = [
      ...(context.gates.planningGates ?? []).map((item) => ({ ...item })),
      { id: "plan-approved", status: "awaiting-approval", requested_at: now(), reason: `plan_sha256=${planSha}` },
    ];
    run.status = "awaiting-approval";
    run.events.push({ at: now(), type: "approval-requested", phase: "planning", ref: projectRelative(projectRoot, context.evidence), detail: `plan_sha256=${planSha}` });
    return { kind: "wait", nextAction: `Show the plan to the user and ask for approval in the conversation. Only after an explicit yes, run paved plan --run ${run.id} --approve --json.` };
  }
  const planSha = gate.reason?.replace(/^plan_sha256=/, "");
  if (!planSha || !/^[a-f0-9]{64}$/.test(planSha)) throw new Error("Workflow approval gate has no valid plan digest.");
  const planRef = run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
  if (!planRef) throw new Error("Workflow approval request has no plan path.");
  const currentPlan = resolveSafePath(projectRoot, planRef);
  if (!existsSync(currentPlan)) return blocked("PAVED_WORKFLOW_PLAN_MISSING", "The plan file is missing.", "Restore the plan file before requesting approval again.");
  const currentSha = sha(readFileSync(currentPlan));
  if (currentSha !== planSha) {
    gate.reason = `plan_sha256=${currentSha}`;
    gate.requested_at = now();
    run.events.push({ at: now(), type: "approval-requested", phase: "planning", ref: planRef, detail: `plan_sha256=${currentSha}` });
    run.status = "awaiting-approval";
    return { kind: "wait", nextAction: `The plan changed, so earlier approval does not cover it. Show the revised plan and ask again; after the user approves it in the conversation, run paved plan --run ${run.id} --approve --json.` };
  }
  if (context.approve && gate.status === "awaiting-approval") recordApproval(projectRoot, run, planSha);
  const decision = readApproval(projectRoot, run, planSha);
  if (!decision) return { kind: "wait", nextAction: `Awaiting the user's approval of plan_sha256 ${planSha}. After an explicit yes in the conversation, run paved plan --run ${run.id} --approve --json.` };
  gate.status = decision.decision; gate.decided_by = decision.decided_by; gate.decided_at = decision.decided_at;
  run.events.push({ at: now(), type: "approval-decided", phase: "planning", ref: "plan-approved" });
  if (decision.decision === "rejected") {
    const failure = { code: "approval-rejected", phase: "planning", reason: "Human rejected the plan.", retry: "non-retryable", next_action: "Revise the plan and start a new run with paved intent." };
    phase.status = "blocked"; phase.failure = failure; run.failure = failure; run.status = "blocked"; run.ended_at = now();
    run.events.push({ at: now(), type: "run-blocked", phase: "planning" });
    return { kind: "wait", nextAction: "The plan was rejected; revise it and start a new run before implementation." };
  }
  run.status = "running";
  return { kind: "pass" };
}

// Only these mean the project's code failed. Anything else (a malformed Tool, a missing
// profile, an unresolvable implementation) is setup the agent fixes without spending an attempt.
const TEST_FAILURE_CODES: ReadonlySet<string> = new Set(["PAVED_TEST_TOOL_FAILED"]);
const VERIFY_FAILURE_CODES: ReadonlySet<string> = new Set(["PAVED_VERIFY_INCOMPLETE"]);

function codeFailed(diagnostics: readonly Diagnostic[], failureCodes: ReadonlySet<string>): boolean {
  const errors = diagnostics.filter((item) => item.category !== "findings");
  return errors.length > 0 && errors.every((item) => failureCodes.has(item.code));
}

function setupBlocked(what: string, diagnostics: readonly Diagnostic[]): PhaseOutcome {
  const problems = diagnostics.filter((item) => item.category !== "findings");
  const detail = problems.map((item) => `${item.code}: ${item.message}${item.remediation ? ` (${item.remediation})` : ""}`).join("; ");
  return blocked("PAVED_WORKFLOW_SETUP_INVALID", `The ${what} setup could not run${detail ? `: ${detail}` : "."}`,
    `Fix the ${what} configuration and advance again; a setup problem does not consume a phase attempt.`);
}

const validation: PhaseHook = async (context) => {
  const tested = await context.tools.test();
  if (tested.status === "awaiting_input") return { kind: "relay", result: tested };
  const ref = (tested.data as { evidence?: string } | undefined)?.evidence;
  context.run.events.push({ at: now(), type: "tool-invoked", phase: "validation", ref: ref ?? "testing-run" });
  if (tested.status !== "success") {
    const unavailable = environmentBlocked(tested.diagnostics);
    if (unavailable) return unavailable;
    if (!codeFailed(tested.diagnostics, TEST_FAILURE_CODES)) return setupBlocked("testing", tested.diagnostics);
    const before = baseline(context.run);
    if (before?.outcome === "failed") {
      const failing = testOutcomes(tested).filter((item) => item.status === "failed");
      const known = new Set(before.failing);
      // Per-Tool attribution needs a baseline that recorded which Tools failed.
      const fresh = known.size === 0 ? [] : failing.filter((item) => !known.has(item.tool));
      const still = known.size === 0 ? [] : failing.filter((item) => known.has(item.tool));
      const attribution = known.size === 0 || failing.length === 0
        ? `The testing Tool already failed when the plan was approved${before.ref ? ` (${before.ref})` : ""}; this failure is not attributed to the change by itself.`
        : [fresh.length ? `Newly failing since approval, likely caused by this change: ${describeTools(fresh)}.` : "No testing Tool that passed at approval fails now.",
          still.length ? `Already failing at approval${before.ref ? ` (${before.ref})` : ""}: ${describeTools(still)}.` : ""].filter(Boolean).join(" ");
      return {
        kind: "fail",
        reason: fresh.length
          ? "The governed tests did not pass, and some of them passed before implementation started."
          : "The governed tests did not pass, and they already failed before implementation started, so the failure may not come from this change.",
        nextAction: "Compare the failure with the baseline evidence, fix what this change broke or make the pre-existing failures pass, then resume this run with paved execute --advance.",
        diagnostics: [...tested.diagnostics, createDiagnostic({
          severity: "warning", category: "findings", code: "PAVED_WORKFLOW_BASELINE_FAILING", component: "workflow.runtime",
          message: attribution,
          remediation: "Make the baseline pass, or exclude the tests that were already failing from the testing Tool.",
        })],
      };
    }
    return { kind: "fail", reason: "The governed regression test did not pass.", nextAction: "Fix the failure and resume this run with paved execute --advance.", diagnostics: tested.diagnostics };
  }
  return { kind: "pass" };
};

const verification: PhaseHook = async (context) => {
  const verified = await context.tools.verify();
  if (verified.status === "awaiting_input") return { kind: "relay", result: verified };
  const data = verified.data as { evidence?: string[]; checks?: { status: string }[]; completion?: { verification?: string } } | undefined;
  if (verified.status !== "success" || data?.completion?.verification !== "verified" || !data.evidence?.length) {
    const checkFailed = (data?.checks ?? []).some((check) => check.status === "failed" || check.status === "error");
    if (!checkFailed || !codeFailed(verified.diagnostics, VERIFY_FAILURE_CODES)) return setupBlocked("verification", verified.diagnostics);
    for (const path of data?.evidence ?? []) context.run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref: path });
    return {
      kind: "fail", reason: "Authoritative Paved verification did not complete successfully.",
      nextAction: "Repair the verification profile or failed checks and resume this run.",
      diagnostics: verified.diagnostics.length ? verified.diagnostics : [createDiagnostic({
        severity: "error", category: "config", code: "PAVED_WORKFLOW_VERIFICATION_FAILED", component: "workflow.runtime",
        message: "Verification did not produce verified evidence.", remediation: "Inspect paved verify --json.",
      })],
    };
  }
  context.run.evidence = data.evidence[0]!;
  // The digest lets paved status tell when the code changed after it was verified.
  context.run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref: context.run.evidence,
    detail: `${VERIFIED_SOURCE}${fingerprint(runSourceRoot(context.projectRoot, context.run))}` });
  return { kind: "pass" };
};

const evidence: PhaseHook = (context) => {
  const { run } = context;
  if (!run.evidence) return blocked("PAVED_WORKFLOW_EVIDENCE_MISSING", "Verified evidence is missing.", "Run the verification phase successfully first.");
  let path = context.evidence;
  if (!path) {
    const summary = context.note ?? run.inputs[0]?.value ?? `Change for run ${run.id}.`;
    const built = writeWorkflowEvidence({ projectRoot: context.projectRoot, run, workflow: context.workflow, summary });
    if ("problem" in built) return blocked("PAVED_WORKFLOW_EVIDENCE_MISSING", built.problem, `Provide --evidence <workflow-evidence.yaml> for run ${run.id}.`);
    path = built.path;
  }
  const authoritative = loadYaml(resolveSafePath(context.projectRoot, run.evidence)) as EvidenceRecord;
  const record = loadYaml(path) as EvidenceRecord;
  const schema = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]).validate(record);
  if (!schema.valid) return blocked("PAVED_WORKFLOW_EVIDENCE_INVALID", schema.errors.join("; "), "Fix the workflow evidence record and retry.");
  const problems = assessWorkflowEvidence(record, context.workflow);
  if (JSON.stringify(record.checks) !== JSON.stringify(authoritative.checks)) problems.push("Workflow check results do not match authoritative Paved verification.");
  const evaluated = evaluateCompletion(record, loadEvidenceRegistry(join(context.coreRoot, "core/verification/registry.yaml")));
  if (evaluated.status !== "complete" || evaluated.verification !== "verified") problems.push(...evaluated.blocking, "Workflow evidence is not complete and verified.");
  if (problems.length) return blocked("PAVED_WORKFLOW_EVIDENCE_INVALID", problems.join("; "), "Record real diff and check evidence matching the Paved verification result.");
  run.evidence = projectRelative(context.projectRoot, path);
  run.events.push({ at: now(), type: "evidence-recorded", phase: "evidence", ref: run.evidence, detail: `sha256=${sha(readFileSync(path))}` });
  return { kind: "pass" };
};

const completion: PhaseHook = (context) => {
  if (!context.run.evidence) return blocked("PAVED_WORKFLOW_EVIDENCE_MISSING", "The run cannot complete without verified evidence.", "Run Paved verification and record its evidence.");
  context.phase.gates = [{ id: "criteria-met", status: "passed" }];
  return { kind: "pass" };
};

const SHARED_PHASES: Readonly<Record<string, PhaseHook>> = { planning, validation, verification, evidence, completion };

export function sharedPhase(phase: string): PhaseHook | undefined {
  return SHARED_PHASES[phase];
}
