import { existsSync } from "node:fs";
import { resolveSafePath } from "../lib/safe-path.js";
import { doneTask, noteTask, resumeTask, startTask } from "../lib/task-handoff.js";
import { createDiagnostic, createResult } from "../result.js";
export function taskHandler(invocation) {
    const [operation, slug, content] = invocation.selectors;
    const valid = slug !== undefined && ((operation === "resume" && invocation.selectors.length === 2) ||
        (["start", "note", "done"].includes(operation ?? "") && invocation.selectors.length === 3 && !!content?.trim()));
    if (!valid)
        return createResult({ command: "task", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_TASK_USAGE", component: "task",
                    message: "Use task start|note|done <slug> <text>, or task resume <slug>.",
                })] });
    if (!existsSync(resolveSafePath(invocation.paths.projectRoot, ".paved/manifest.yaml"))) {
        return createResult({ command: "task", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "config", code: "PAVED_TASK_UNINITIALIZED", component: "task",
                    message: "Paved is not initialized in this repository.",
                })] });
    }
    try {
        const root = invocation.paths.projectRoot;
        const task = operation === "start" ? startTask(root, slug, content) :
            operation === "note" ? noteTask(root, slug, content) :
                operation === "done" ? doneTask(root, slug, content) : resumeTask(root, slug);
        return createResult({ command: "task", status: "success", data: task });
    }
    catch (error) {
        return createResult({ command: "task", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "config", code: "PAVED_TASK_FAILED", component: "task",
                    message: error instanceof Error ? error.message : "Cannot access task handoff.",
                })] });
    }
}
