import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "../atomic-write.js";
import { loadYaml } from "../documents.js";
import { resolveSafePath } from "../safe-path.js";
import { createRegistry } from "../schemas.js";
import { assessRun } from "../workflows.js";
function pathFor(projectRoot, id) {
    if (!/^[a-z][a-z0-9-]{5,80}$/.test(id))
        throw new Error(`Invalid workflow run id: ${id}.`);
    return resolveSafePath(projectRoot, `.paved/generated/runs/${id}.yaml`);
}
function validateRun(projectRoot, coreRoot, run) {
    const schema = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(run);
    if (!schema.valid || !run.id)
        throw new Error(`Workflow run ${run.id} is invalid: ${schema.errors.join("; ")}`);
    const workflowName = run.workflow.id.split(".").at(-1);
    if (!workflowName || !["bug", "feature", "refactor"].includes(workflowName)) {
        throw new Error(`Workflow run ${run.id} names an unsupported workflow.`);
    }
    const workflow = loadYaml(join(coreRoot, "core/workflows", workflowName, "workflow.yaml"));
    const problems = assessRun(run, workflow);
    if (problems.length)
        throw new Error(`Workflow run ${run.id} is inconsistent: ${problems.join("; ")}`);
    pathFor(projectRoot, run.id);
}
export function readDecisionRun(projectRoot, coreRoot, id) {
    const path = pathFor(projectRoot, id);
    if (!existsSync(path))
        return undefined;
    const run = loadYaml(path);
    validateRun(projectRoot, coreRoot, run);
    if (run.id !== id)
        throw new Error(`Workflow run ${id} does not match its document id.`);
    return run;
}
export function writeDecisionRun(projectRoot, coreRoot, run) {
    validateRun(projectRoot, coreRoot, run);
    atomicWriteFileSync(pathFor(projectRoot, run.id), stringify(run));
}
export function listRunDecisions(projectRoot, coreRoot) {
    const dir = join(projectRoot, ".paved/generated/runs");
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".yaml"))
            return [];
        const run = readDecisionRun(projectRoot, coreRoot, entry.name.slice(0, -5));
        return run?.decisions ?? [];
    });
}
export function readRunDecision(projectRoot, coreRoot, id) {
    return listRunDecisions(projectRoot, coreRoot).find((decision) => decision.id === id);
}
