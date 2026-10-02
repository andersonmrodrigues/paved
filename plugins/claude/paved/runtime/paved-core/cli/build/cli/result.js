export const EXIT_CODES = {
    success: 0,
    findings: 1,
    usage: 2,
    environment: 3,
    config: 4,
    resolution: 5,
    "generation/update": 6,
    verification: 7,
    conflict: 8,
    internal: 9,
    "awaiting-input": 10,
};
const CATEGORY_PRECEDENCE = {
    success: 0,
    findings: 1,
    usage: 2,
    environment: 3,
    config: 4,
    resolution: 5,
    "generation/update": 6,
    verification: 7,
    conflict: 8,
    internal: 9,
    "awaiting-input": 10,
};
export function createDiagnostic(input) {
    const diagnostic = {
        severity: input.severity,
        category: input.category,
        code: input.code,
        component: input.component,
        message: input.message,
    };
    return input.remediation === undefined
        ? diagnostic
        : { ...diagnostic, remediation: input.remediation };
}
function hasBlockingDiagnostic(diagnostics) {
    return diagnostics.some((diagnostic) => diagnostic.category !== "findings");
}
export function createResult(input) {
    const diagnostics = input.diagnostics ?? [];
    const decisions = input.decisions ?? [];
    // Symmetric to the malformed-failure rule: awaiting_input is only meaningful when
    // there is a required question and nothing that blocks acting on its answer.
    if (input.status === "awaiting_input") {
        const problem = !decisions.some((decision) => decision.required)
            ? "awaiting_input requires at least one required decision."
            : hasBlockingDiagnostic(diagnostics)
                ? "awaiting_input cannot accompany a blocking diagnostic."
                : undefined;
        if (problem !== undefined) {
            return createResult({
                ...input,
                status: "failed",
                diagnostics: [
                    ...diagnostics,
                    createDiagnostic({
                        severity: "error",
                        category: "internal",
                        code: "PAVED_RESULT_MALFORMED_AWAITING_INPUT",
                        component: "cli.result",
                        message: `Malformed awaiting_input result: ${problem}`,
                        remediation: "Raise a required decision, or report the blocker as a diagnostic instead.",
                    }),
                ],
            });
        }
    }
    const normalizedDiagnostics = input.status === "failed" && !hasBlockingDiagnostic(diagnostics)
        ? [
            ...diagnostics,
            createDiagnostic({
                severity: "error",
                category: "internal",
                code: "PAVED_RESULT_MALFORMED_FAILURE",
                component: "cli.result",
                message: "Malformed failed result: failed status requires at least one blocking diagnostic.",
                remediation: "Add a diagnostic category other than findings for failed command results.",
            }),
        ]
        : diagnostics;
    const base = {
        command: input.command,
        status: input.status,
        diagnostics: normalizedDiagnostics,
        ...(decisions.length === 0 ? {} : { decisions }),
    };
    return input.data === undefined ? base : { ...base, data: input.data };
}
export function primaryCategory(result) {
    // The awaiting_input invariant guarantees there is no blocking diagnostic to escalate.
    if (result.status === "awaiting_input")
        return "awaiting-input";
    let primary = result.status === "success" ? "success" : "findings";
    for (const diagnostic of result.diagnostics) {
        if (CATEGORY_PRECEDENCE[diagnostic.category] > CATEGORY_PRECEDENCE[primary]) {
            primary = diagnostic.category;
        }
    }
    return primary;
}
export function exitCode(result) {
    return EXIT_CODES[primaryCategory(result)];
}
