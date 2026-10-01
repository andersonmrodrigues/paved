import { existsSync } from "node:fs";
import { loadYaml } from "../lib/documents.js";
import { resolveSafePath } from "../lib/safe-path.js";
import { createDiagnostic, createResult } from "../result.js";
import { workflowHandler } from "./workflow.js";
const workflowNames = ["feature", "fix", "refactor"];
function failure(invocation, code, message, remediation) {
    return createResult({ command: invocation.command, status: "failed", diagnostics: [createDiagnostic({
                severity: "error", category: "usage", code, component: "workflow.command", message, remediation,
            })] });
}
export async function workflowAliasHandler(invocation) {
    const alias = invocation.command;
    let workflow;
    if (alias === "plan")
        workflow = "feature";
    else if (alias === "debug")
        workflow = "fix";
    else {
        const id = invocation.flags.run;
        if (!id)
            return failure(invocation, "PAVED_WORKFLOW_RUN_REQUIRED", `${alias} requires a durable workflow run.`, `Start paved feature, fix, or refactor, then pass --run <id> to paved ${alias}.`);
        try {
            const path = resolveSafePath(invocation.paths.projectRoot, `.paved/generated/runs/${id}.yaml`);
            if (!existsSync(path))
                throw new Error("Run does not exist.");
            const run = loadYaml(path);
            const name = run.workflow?.id === "core.bug" ? "fix" : run.workflow?.id?.replace(/^core\./, "");
            if (!workflowNames.includes(name))
                throw new Error("Run does not name a supported workflow.");
            workflow = name;
            const requiredPhase = alias === "implement" ? "implementation" : "review";
            if (!run.phases?.some((phase) => phase.phase === requiredPhase && phase.status === "running")) {
                return failure(invocation, "PAVED_WORKFLOW_PHASE_BLOCKED", `${alias} is available only during the ${requiredPhase} phase.`, `Resume paved ${workflow} --run ${id} to inspect the current phase.`);
            }
        }
        catch (error) {
            return failure(invocation, "PAVED_WORKFLOW_RUN_INVALID", error instanceof Error ? error.message : "Run is invalid.", "Use a valid run id from paved feature, fix, or refactor.");
        }
    }
    const result = await workflowHandler({ ...invocation, command: workflow });
    return { ...result, command: alias };
}
