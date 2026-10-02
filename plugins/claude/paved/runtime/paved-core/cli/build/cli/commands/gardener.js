import { analyzeGardener, GardenerInputError } from "../lib/gardener.js";
import { createDiagnostic, createResult } from "../result.js";
import { runDecisionGate } from "../lib/decisions/gate.js";
import { gardenerProvider } from "../lib/decisions/providers/gardener.js";
import { gardenerHandler as adoptionHandler } from "../lib/decisions/handlers/gardener.js";
export function gardenerHandler(invocation) {
    try {
        const result = analyzeGardener(invocation.paths);
        const count = result.proposals.filter((proposal) => proposal.status === "CANDIDATE").length;
        const outcome = runDecisionGate({
            context: {
                projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
                command: "gardener", answers: invocation.flags.answers,
                ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
            },
            providers: [gardenerProvider], handlers: new Map([["gardener.adopt", adoptionHandler]]),
            persist: invocation.flags.answers.length > 0,
        });
        const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
            severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID", component: "gardener", message,
        }));
        return createResult({
            command: "gardener", status: decisionDiagnostics.length > 0 ? "failed" : count > 0 ? "warning" : "success",
            decisions: outcome.projections,
            data: { ...result, dryRun: invocation.flags.dryRun, approvalRequired: true },
            diagnostics: [...decisionDiagnostics, ...(count > 0 ? [createDiagnostic({
                        severity: "warning", category: "findings", code: "PAVED_GARDENER_PROPOSALS", component: "gardener",
                        message: `${count} improvement proposal(s) require human review.`,
                    })] : [])],
        });
    }
    catch (error) {
        return createResult({ command: "gardener", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: error instanceof GardenerInputError ? "config" : "internal",
                    code: error instanceof GardenerInputError ? "PAVED_GARDENER_INPUT" : "PAVED_GARDENER_FAILURE",
                    component: "gardener", message: error instanceof GardenerInputError ? error.message : "Gardener analysis failed.",
                })] });
    }
}
