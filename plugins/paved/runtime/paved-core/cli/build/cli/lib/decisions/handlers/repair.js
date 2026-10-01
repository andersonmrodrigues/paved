import { runGeneratorsUnderExistingOperationLock } from "../../generator-runtime.js";
function apply(answer, context) {
    if (answer === "skip")
        return [];
    if (answer !== "apply")
        throw new Error(`Unknown repair option: ${String(answer)}.`);
    const run = runGeneratorsUnderExistingOperationLock(context.coreRoot, context.projectRoot);
    const errors = run.executions.flatMap((execution) => execution.errors.map((error) => `${execution.generator}: ${error}`));
    if (errors.length > 0)
        throw new Error(`Context repair failed: ${errors.join("; ")}`);
    return [...new Set(run.executions.flatMap((execution) => [...execution.outputs, ...execution.proposals]))]
        .sort((a, b) => a.localeCompare(b, "en"));
}
export const repairHandler = {
    effect: "repository-mutating", apply, reject: (answer) => answer === "skip",
};
