import type { CommandResult, Diagnostic } from "../../result.ts";
import type { WorkflowContract } from "../workflows.ts";
import type { Gate, Phase, Run } from "../workflow-runs.ts";
import { bugGates } from "./bug.ts";
import { featureGates } from "./feature.ts";
import { refactorGates } from "./refactor.ts";
import { implementationChanged, recordObservation, SHARED_GATES, sharedPhase } from "./shared.ts";

/** The testing Tool and verification, invoked with only the answers meant for them. */
export interface PhaseTools {
  readonly test: () => Promise<CommandResult>;
  readonly verify: () => Promise<CommandResult>;
}

export interface PhaseContext {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly run: Run;
  readonly phase: Phase;
  readonly workflow: WorkflowContract;
  readonly gates: WorkflowGates;
  readonly tools: PhaseTools;
  /** The user approved the current plan in the conversation (`paved plan --approve`). */
  readonly approve: boolean;
  readonly note?: string;
  /** Absolute path of an existing file inside the project. */
  readonly evidence?: string;
}

export type PhaseOutcome =
  | { readonly kind: "pass"; readonly ref?: string }
  | { readonly kind: "blocked"; readonly code: string; readonly message: string; readonly remediation: string }
  | { readonly kind: "fail"; readonly reason: string; readonly nextAction: string; readonly diagnostics: readonly Diagnostic[] }
  | { readonly kind: "wait"; readonly nextAction: string }
  | { readonly kind: "relay"; readonly result: CommandResult };

export type PhaseHook = (context: PhaseContext) => PhaseOutcome | Promise<PhaseOutcome>;

export interface WorkflowGates {
  readonly workflow: string;
  /** Gate ids this module decides; with SHARED_GATES they must cover the contract exactly. */
  readonly handles: readonly string[];
  /** Gates recorded alongside `plan-approved` when approval is requested. */
  readonly planningGates?: readonly Gate[];
  /** Phases whose hook runs the testing Tool and may relay its decisions. */
  readonly relays?: readonly string[];
  readonly phases: Readonly<Record<string, PhaseHook>>;
}

const REGISTRY: ReadonlyMap<string, WorkflowGates> = new Map([featureGates, bugGates, refactorGates].map((gates) => [gates.workflow, gates]));

export function gatesFor(workflowId: string): WorkflowGates {
  const gates = REGISTRY.get(workflowId);
  if (!gates) throw new Error(`Workflow ${workflowId} has no gate handlers and cannot be executed.`);
  return gates;
}

export function executableWorkflows(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function handledGates(workflowId: string): ReadonlySet<string> {
  return new Set([...SHARED_GATES, ...gatesFor(workflowId).handles]);
}

export function relaysAnswers(workflowId: string, phase: string): boolean {
  return phase === "validation" || phase === "verification" || (gatesFor(workflowId).relays ?? []).includes(phase);
}

export async function runPhase(input: Omit<PhaseContext, "gates">): Promise<PhaseOutcome> {
  const context: PhaseContext = { ...input, gates: gatesFor(input.workflow.id) };
  const shared = sharedPhase(context.phase.phase);
  if (shared) return shared(context);
  if (!context.note) {
    return { kind: "blocked", code: "PAVED_WORKFLOW_OBSERVATION_REQUIRED", message: `${context.phase.phase} requires a concrete observation.`, remediation: "Advance again with --note <observation>." };
  }
  if (context.phase.phase === "implementation") {
    const unchanged = implementationChanged(context);
    if (unchanged) return unchanged;
  }
  const hook = context.gates.phases[context.phase.phase];
  const outcome = hook ? await hook(context) : { kind: "pass" as const };
  if (outcome.kind !== "pass") return outcome;
  recordObservation(context, outcome.ref);
  return { kind: "pass" };
}
