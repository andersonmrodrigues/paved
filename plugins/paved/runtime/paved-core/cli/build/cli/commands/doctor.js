import { createDiagnostic, createResult } from "../result.js";
import { inspectConsumer } from "../lib/consumer-state.js";
import { statusData } from "./status.js";
import { runDecisionGate } from "../lib/decisions/gate.js";
import { repairProvider } from "../lib/decisions/providers/repair.js";
import { repairHandler } from "../lib/decisions/handlers/repair.js";
function statusFor(diagnostics) {
    if (diagnostics.some((diagnostic) => diagnostic.category !== "findings"))
        return "failed";
    return diagnostics.length > 0 ? "warning" : "success";
}
export function doctorHandler(invocation) {
    const inspection = inspectConsumer({
        projectRoot: invocation.paths.projectRoot,
        coreRoot: invocation.paths.coreRoot,
        adapterSelections: invocation.flags.adapters,
        ...(invocation.paths.manifestPath === undefined ? {} : { manifestPath: invocation.paths.manifestPath }),
    });
    const outcome = runDecisionGate({
        context: {
            projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
            command: "doctor", answers: invocation.flags.answers,
            ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
        },
        providers: [repairProvider], handlers: new Map([["repair.apply", repairHandler]]),
        persist: invocation.flags.answers.length > 0,
    });
    const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
        severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
        component: "cli.doctor", message,
        remediation: "Use the offered option id and provide the required human-authored approval.",
    }));
    return createResult({
        command: "doctor",
        status: statusFor([...inspection.diagnostics, ...decisionDiagnostics]),
        decisions: outcome.projections,
        data: {
            ...statusData(inspection),
            actionableFindings: inspection.diagnostics.map((diagnostic) => ({
                code: diagnostic.code,
                severity: diagnostic.severity,
                category: diagnostic.category,
                component: diagnostic.component,
                message: diagnostic.message,
                remediation: diagnostic.remediation,
            })),
        },
        diagnostics: [...inspection.diagnostics, ...decisionDiagnostics],
    });
}
