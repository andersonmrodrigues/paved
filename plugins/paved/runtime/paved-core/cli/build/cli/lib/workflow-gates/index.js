import { bugGates } from "./bug.js";
import { featureGates } from "./feature.js";
import { refactorGates } from "./refactor.js";
import { implementationChanged, recordObservation, SHARED_GATES, sharedPhase } from "./shared.js";
const REGISTRY = new Map([featureGates, bugGates, refactorGates].map((gates) => [gates.workflow, gates]));
export function gatesFor(workflowId) {
    const gates = REGISTRY.get(workflowId);
    if (!gates)
        throw new Error(`Workflow ${workflowId} has no gate handlers and cannot be executed.`);
    return gates;
}
export function executableWorkflows() {
    return [...REGISTRY.keys()].sort();
}
export function handledGates(workflowId) {
    return new Set([...SHARED_GATES, ...gatesFor(workflowId).handles]);
}
export function relaysAnswers(workflowId, phase) {
    return phase === "validation" || phase === "verification" || (gatesFor(workflowId).relays ?? []).includes(phase);
}
export async function runPhase(input) {
    const context = { ...input, gates: gatesFor(input.workflow.id) };
    const shared = sharedPhase(context.phase.phase);
    if (shared)
        return shared(context);
    if (!context.note) {
        return { kind: "blocked", code: "PAVED_WORKFLOW_OBSERVATION_REQUIRED", message: `${context.phase.phase} requires a concrete observation.`, remediation: "Advance again with --note <observation>." };
    }
    if (context.phase.phase === "implementation") {
        const unchanged = implementationChanged(context);
        if (unchanged)
            return unchanged;
    }
    const hook = context.gates.phases[context.phase.phase];
    const outcome = hook ? await hook(context) : { kind: "pass" };
    if (outcome.kind !== "pass")
        return outcome;
    recordObservation(context, outcome.ref);
    return { kind: "pass" };
}
