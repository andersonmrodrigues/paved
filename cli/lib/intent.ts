import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { hashLocalFile } from "./local-core.ts";
import { resolveSafePath } from "./safe-path.ts";
import type { DecisionCandidate } from "./decisions/gate.ts";
import type { Decision } from "./decisions/record.ts";
import { executableWorkflows } from "./workflow-gates/index.ts";
import { fingerprint, now, sha } from "./workflow-gates/shared.ts";
import { ESCALATED, LANES, skippedInLane, type AutonomyProfile, type Lane } from "./workflows.ts";
import { coreWorkflowIds, intentDocumentPath, loadContract, startPhaseFrom, type Run, type RunInput } from "./workflow-runs.ts";

export { intentDocumentPath };

export interface IntentRequest {
  readonly request: string;
  readonly workflow?: string;
  readonly lane?: string;
  readonly autonomy?: string;
  readonly recommend?: string;
  readonly because?: string;
  readonly parts: readonly string[];
  readonly inputs: readonly string[];
}

export class IntentError extends Error {
  readonly code: string;
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.code = code;
    this.remediation = remediation;
  }
}

interface WorkflowOverride { target?: string; action?: string; target_sha256?: string }

function disabledWorkflows(projectRoot: string, coreRoot: string): Set<string> {
  const path = join(projectRoot, ".paved/overrides/overrides.yaml");
  if (!existsSync(path)) return new Set();
  const entries = ((loadYaml(path) as { workflows?: WorkflowOverride[] } | null)?.workflows ?? []);
  return new Set(entries.flatMap((entry) => {
    if (entry.action !== "disable" || !entry.target?.startsWith("core.")) return [];
    const target = `core/workflows/${entry.target.slice("core.".length)}/workflow.yaml`;
    if (!existsSync(join(coreRoot, target))) return [];
    // A disable written against another version of the workflow no longer applies; status reports the drift.
    return !entry.target_sha256 || entry.target_sha256 === hashLocalFile(coreRoot, target) ? [entry.target] : [];
  }));
}

export function availableWorkflows(projectRoot: string, coreRoot: string): string[] {
  const disabled = disabledWorkflows(projectRoot, coreRoot);
  const core = new Set(coreWorkflowIds(coreRoot));
  return executableWorkflows().filter((id) => core.has(id) && !disabled.has(id));
}

export function normalizeWorkflow(projectRoot: string, coreRoot: string, value: string): string {
  const id = value.includes(".") ? value : `core.${value}`;
  const available = availableWorkflows(projectRoot, coreRoot);
  if (available.includes(id)) return id;
  const reason = !id.startsWith("core.") ? `${value} is not a Core workflow; project workflows cannot be executed.`
    : coreWorkflowIds(coreRoot).includes(id) ? `${id} is disabled in .paved/overrides/overrides.yaml.`
      : `${id} does not exist in this Core.`;
  throw new IntentError("PAVED_WORKFLOW_NOT_EXECUTABLE", reason, `Choose one of: ${available.join(", ")}.`);
}

export function parseInputs(coreRoot: string, workflowId: string, values: readonly string[]): RunInput[] {
  const declared = new Set(loadContract(coreRoot, workflowId).inputs.map((input) => input.id));
  const fromRequest = firstRequiredInput(coreRoot, workflowId);
  return values.map((value) => {
    const index = value.indexOf("=");
    const id = index > 0 ? value.slice(0, index) : "";
    const text = index > 0 ? value.slice(index + 1).trim() : "";
    if (!declared.has(id) || !text) {
      throw new IntentError("PAVED_WORKFLOW_INPUT_INVALID", `Input ${value} is not <id>=<value> for an input ${workflowId} declares.`, `Declared inputs: ${[...declared].join(", ")}.`);
    }
    if (id === fromRequest) {
      throw new IntentError("PAVED_WORKFLOW_INPUT_INVALID", `The request is the ${id} input of ${workflowId}; --input ${id} would replace it.`, "Put that text in the request instead.");
    }
    return { id, value: text, source: "human" as const };
  });
}

export function missingInputs(coreRoot: string, workflowId: string, inputs: readonly RunInput[]): string[] {
  const received = new Set(inputs.map((input) => input.id));
  return loadContract(coreRoot, workflowId).inputs.filter((input) => input.required && !received.has(input.id)).map((input) => input.id);
}

function firstRequiredInput(coreRoot: string, workflowId: string): string {
  const input = loadContract(coreRoot, workflowId).inputs.find((item) => item.required);
  if (!input) throw new Error(`Workflow ${workflowId} declares no required input for the request.`);
  return input.id;
}

export function parseLane(value: string | undefined): Lane | undefined {
  if (value === undefined) return undefined;
  if (!(LANES as readonly string[]).includes(value)) {
    throw new IntentError("PAVED_LANE_INVALID", `Unknown lane: ${value}.`, `Choose one of: ${LANES.join(", ")}.`);
  }
  return value as Lane;
}

/** Gives a pending or new run its workflow, lane, phases and request input. */
export function classify(coreRoot: string, run: Run, workflowId: string, because: string, decidedBy: "agent" | "human", decision?: string, lane?: Lane): void {
  const contract = loadContract(coreRoot, workflowId);
  if (run.autonomy_profile === undefined && contract.autonomy !== undefined) run.autonomy_profile = contract.autonomy.default_profile;
  const request = run.inputs.find((input) => input.id === "request") ?? run.inputs[0]!;
  const first = firstRequiredInput(coreRoot, workflowId);
  run.inputs = [{ ...request, id: first }, ...run.inputs.filter((input) => input !== request && input.id !== first)];
  run.workflow = { id: contract.id, version: contract.version };
  run.classification = {
    workflow: contract.id, because, decided_by: decidedBy,
    ...(decision === undefined ? {} : { decision }),
    ...(run.classification?.parts === undefined ? {} : { parts: run.classification.parts }),
    ...(lane === undefined ? {} : { lane, lane_because: because }),
  };
  run.phases = contract.phases.map((phase) => ({ phase: phase.phase, status: "pending" }));
  run.status = "running";
  startPhaseFrom(run, contract, 0);
}

/**
 * Moves a run to the risky lane. Planning a lower lane skipped is reopened and everything
 * after it goes back to pending, so the plan is approved before the change is implemented,
 * verified and reviewed again. Phases before planning keep their recorded outcome.
 */
export function escalate(coreRoot: string, run: Run, because: string): void {
  if (!run.workflow || run.classification?.workflow === undefined) {
    throw new IntentError("PAVED_LANE_ESCALATION_INVALID", `Run ${run.id} is not classified yet.`, "Answer its classification decision first.");
  }
  if (run.classification.lane === "risky") {
    throw new IntentError("PAVED_LANE_ESCALATION_INVALID", `Run ${run.id} is already in the risky lane.`, "Continue the run; its plan needs approval before completion.");
  }
  const planning = run.phases.findIndex((phase) => phase.phase === "planning");
  if (planning < 0) {
    throw new IntentError("PAVED_LANE_ESCALATION_INVALID", `${run.workflow.id} has no planning phase, so a risky lane adds nothing to it.`, "Continue the run as it is, or start a change workflow for the change.");
  }
  if (run.status === "awaiting-input" || run.status === "awaiting-approval") {
    throw new IntentError("PAVED_LANE_ESCALATION_INVALID", `Run ${run.id} is ${run.status}.`, "Answer the open decision or approval first, then escalate.");
  }
  const from = run.classification.lane;
  run.classification = { ...run.classification, lane: "risky", lane_because: because };
  run.events.push({ at: now(), type: "lane-escalated", detail: `from=${from ?? "none"}; ${because}`.slice(0, 4000) });
  if (run.phases[planning]!.status !== "skipped") return;
  for (const phase of run.phases.slice(planning)) {
    if (phase.status === "pending") continue;
    if (phase.status !== "skipped") run.events.push({ at: now(), type: "phase-reopened", phase: phase.phase, detail: ESCALATED });
    phase.status = "pending";
    delete phase.gates; delete phase.failure; delete phase.skip_reason; delete phase.skipped_in_lane;
  }
  if (run.delegation) {
    run.events.push({ at: now(), type: "delegation-superseded", phase: "implementation", ref: run.delegation.path, detail: ESCALATED });
    delete run.delegation;
  }
  delete run.failure; delete run.ended_at;
  run.status = "running";
  startPhaseFrom(run, loadContract(coreRoot, run.workflow.id), planning);
}

/** `worktree` is the linked worktree the run works on when it shares the state of projectRoot. */
export function createIntentRun(projectRoot: string, coreRoot: string, input: IntentRequest, revision: string, worktree?: string): Run {
  if (input.autonomy !== undefined && !["guided", "balanced", "autonomous"].includes(input.autonomy)) {
    throw new IntentError("PAVED_AUTONOMY_PROFILE_INVALID", `Unknown autonomy profile: ${input.autonomy}.`, "Choose guided, balanced or autonomous.");
  }
  const request = input.request.trim();
  if (!request) throw new IntentError("PAVED_WORKFLOW_INPUT_REQUIRED", "intent requires the user's request.", "Run paved intent \"<request>\" --json.");
  const lane = parseLane(input.lane);
  if (lane !== undefined && input.workflow === undefined) {
    throw new IntentError("PAVED_INTENT_FLAGS_INVALID", "A lane is chosen together with the workflow, and no --workflow was given.", "Add --workflow <id> --because \"<evidence>\", or drop --lane and let the user classify the request.");
  }
  if ((input.workflow !== undefined || input.recommend !== undefined) && !input.because?.trim()) {
    throw new IntentError("PAVED_INTENT_RATIONALE_REQUIRED", "A workflow choice or recommendation needs the evidence behind it.", "Add --because \"<what in the request or repository shows it>\".");
  }
  if (input.because !== undefined && input.workflow === undefined && input.recommend === undefined) {
    throw new IntentError("PAVED_INTENT_FLAGS_INVALID", "--because explains a --workflow choice or a --recommend recommendation, and neither was given.", "Add --workflow or --recommend, or drop --because.");
  }
  if (input.inputs.length > 0 && input.workflow === undefined) {
    throw new IntentError("PAVED_INTENT_FLAGS_INVALID", "--input needs a workflow, and this intent is not classified yet.", "Drop --input now and pass it when you resume with the classification answer: paved intent --run <id> --answer <id>=<workflow> --input <id>=<value>.");
  }
  if (input.parts.length === 1) throw new IntentError("PAVED_INTENT_PARTS_INVALID", "A split needs at least two parts.", "Pass --part once per independent change, or none.");
  if (input.workflow !== undefined && input.parts.length > 0) throw new IntentError("PAVED_INTENT_PARTS_INVALID", "A classified intent cannot also propose a split.", "Use either --workflow or --part.");
  const workflowId = input.workflow === undefined ? undefined : normalizeWorkflow(projectRoot, coreRoot, input.workflow);
  if (input.recommend !== undefined) normalizeWorkflow(projectRoot, coreRoot, input.recommend);
  const created = now();
  const run: Run = {
    apiVersion: "paved/v1", kind: "WorkflowRun",
    id: `intent-${sha(`${request}\0${revision}`).slice(0, 20)}`,
    revision, ...(worktree === undefined ? {} : { worktree }), started_at: created, status: "awaiting-input",
    ...(input.autonomy === undefined ? {} : { autonomy_profile: input.autonomy as AutonomyProfile }),
    classification: input.parts.length > 0 ? { parts: [...input.parts] } : {},
    inputs: [{ id: "request", value: request, source: "human" }],
    phases: [],
    events: [{ at: created, type: "run-started", detail: `source_sha256=${fingerprint(worktree ?? projectRoot)}` }],
  };
  if (workflowId !== undefined) {
    run.inputs.push(...parseInputs(coreRoot, workflowId, input.inputs));
    classify(coreRoot, run, workflowId, input.because!.trim(), "agent", undefined, lane);
    const missing = missingInputs(coreRoot, workflowId, run.inputs);
    if (missing.length) throw new IntentError("PAVED_WORKFLOW_INPUT_MISSING", `${workflowId} requires: ${missing.join(", ")}.`, `Ask the user, then pass --input ${missing[0]}=<value>.`);
  }
  return run;
}

/** `coreRoot` lets the document name every phase the run's lane skips, not only those skipped so far. */
export function writeIntentDocument(projectRoot: string, run: Run, coreRoot?: string): string {
  const relative = intentDocumentPath(run.id);
  const classification = run.classification ?? {};
  const lines = [
    `# Intent ${run.id}`, "",
    "## Request", "", ...run.inputs.filter((input) => input === run.inputs[0]).map((input) => `> ${input.value.replaceAll("\n", "\n> ")}`), "",
    "## Classification", "",
    ...(classification.workflow
      ? [`- Workflow: \`${classification.workflow}\``, `- Decided by: ${classification.decided_by}`, `- Because: ${classification.because}`, ...(classification.decision ? [`- Decision: \`${classification.decision}\``] : []),
        ...(classification.lane
          ? [`- Lane: \`${classification.lane}\``, ...(classification.lane_because !== classification.because ? [`- Lane because: ${classification.lane_because}`] : []),
            ...skippedPhases(run, coreRoot)]
          : ["- Lane: none chosen; every phase runs."])]
      : run.status === "cancelled" ? ["- Split into separate intents (see below)."]
        : [`- Pending: a classification decision is open in \`.paved/generated/runs/${run.id}.yaml\`.`]),
    "",
    ...(classification.parts ? ["## Proposed split", "", ...classification.parts.map((part, index) => `${index + 1}. ${part}`), ""] : []),
    "## Inputs", "", ...run.inputs.map((input) => `- \`${input.id}\` (${input.source}): ${input.value}`), "",
  ];
  const path = resolveSafePath(projectRoot, relative);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${lines.join("\n")}\n`);
  return relative;
}

function skippedPhases(run: Run, coreRoot: string | undefined): string[] {
  const lane = run.classification?.lane;
  const contract = coreRoot === undefined || run.workflow === undefined ? undefined : loadContract(coreRoot, run.workflow.id);
  const skipped = run.phases.filter((phase) => phase.skipped_in_lane !== undefined
    || (phase.status === "pending" && contract?.phases.some((item) => item.phase === phase.phase && skippedInLane(item, lane)) === true))
    .map((phase) => `\`${phase.phase}\``);
  return skipped.length ? [`- Skipped by the lane: ${skipped.join(", ")}`] : [];
}

export function classificationCandidate(projectRoot: string, coreRoot: string, run: Run, recommend?: string, because?: string): DecisionCandidate {
  const parts = run.classification?.parts;
  const workflows = availableWorkflows(projectRoot, coreRoot).map((id) => {
    const contract = loadContract(coreRoot, id);
    return { id: id.slice("core.".length), label: id.slice("core.".length), description: contract.description.trim(), consequence: parts ? `Treat the whole request as one ${id} run.` : `Run the request through ${id}.` };
  });
  const options = parts
    ? [{ id: "split", label: "split", description: `Handle as ${parts.length} separate intents: ${parts.join("; ")}.`, consequence: "This run is cancelled and each part is classified on its own." }, ...workflows]
    : workflows;
  const document = resolveSafePath(projectRoot, intentDocumentPath(run.id));
  // Option ids must be names (no dots), so the options are the bare workflow names.
  const recommended = parts ? "split" : recommend?.replace(/^core\./, "");
  return {
    scope: "run",
    question: parts ? "This request mixes changes of different kinds. How should it be handled?" : "Which workflow should handle this request?",
    reason: (parts ? "Each workflow proves a different kind of change; one run cannot follow two." : "The agent could not establish the kind of change from the evidence it has.")
      + (recommend !== undefined && because ? ` The agent suggests ${recommend} because: ${because}` : ""),
    options,
    ...(recommended === undefined ? {} : { recommended }),
    evidence: [{ type: "file", location: intentDocumentPath(run.id), sha256: sha(readFileSync(document)) }],
    required: true,
    requiredAnswer: { type: "single-choice" },
    effect: "record-only",
    handler: "run.record",
    candidates: options.map((option) => option.id),
  };
}

export function applyClassificationAnswer(projectRoot: string, coreRoot: string, run: Run, decision: Decision): { split?: string[] } {
  const answer = String(decision.answer);
  if (answer === "split") {
    const parts = run.classification?.parts ?? [];
    run.status = "cancelled";
    run.ended_at = now();
    run.classification = { ...run.classification, decision: decision.id };
    run.events.push({ at: now(), type: "run-cancelled", ref: decision.id, detail: "intent-split" });
    return { split: [...parts] };
  }
  classify(coreRoot, run, normalizeWorkflow(projectRoot, coreRoot, answer), `Chosen by ${decision.answered_by} in decision ${decision.id}.`, "human", decision.id);
  return {};
}
