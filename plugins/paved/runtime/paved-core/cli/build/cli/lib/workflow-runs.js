import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadYaml } from "./documents.js";
import { resolveSafePath } from "./safe-path.js";
import { createRegistry } from "./schemas.js";
import { assessRun } from "./workflows.js";
/** `failed` is not terminal: a failed phase may be retried. */
export const TERMINAL_STATUSES = new Set(["completed", "completed-with-warnings", "blocked", "cancelled"]);
export function runPath(projectRoot, id) {
    if (!/^[a-z][a-z0-9-]{5,80}$/.test(id))
        throw new Error(`Invalid workflow run id: ${id}.`);
    return resolveSafePath(projectRoot, `.paved/generated/runs/${id}.yaml`);
}
export function coreWorkflowIds(coreRoot) {
    const root = join(coreRoot, "core/workflows");
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "workflow.yaml")))
        .map((entry) => `core.${entry.name}`)
        .sort();
}
export function loadContract(coreRoot, workflowId) {
    const name = /^core\.([a-z][a-z0-9-]*)$/.exec(workflowId)?.[1];
    if (!name)
        throw new Error(`Workflow ${workflowId} is not a Core workflow.`);
    const path = join(coreRoot, "core/workflows", name, "workflow.yaml");
    if (!existsSync(path))
        throw new Error(`Workflow ${workflowId} does not exist in this Core.`);
    const contract = loadYaml(path);
    if (contract.id !== workflowId)
        throw new Error(`Workflow file ${name} declares ${contract.id}, not ${workflowId}.`);
    return contract;
}
export function validateRun(coreRoot, run) {
    const schema = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(run);
    if (!schema.valid)
        throw new Error(`Workflow run ${run.id} is invalid: ${schema.errors.join("; ")}`);
    if (!run.workflow)
        return;
    const classified = run.classification?.workflow;
    if (classified !== undefined && classified !== run.workflow.id) {
        throw new Error(`Workflow run ${run.id} is classified as ${classified} but runs ${run.workflow.id}.`);
    }
    const record = { ...run, workflow: run.workflow };
    const problems = assessRun(record, loadContract(coreRoot, run.workflow.id));
    if (problems.length)
        throw new Error(`Workflow run ${run.id} is inconsistent: ${problems.join("; ")}`);
}
export function readRun(projectRoot, coreRoot, id) {
    const path = runPath(projectRoot, id);
    if (!existsSync(path))
        return undefined;
    const run = loadYaml(path);
    if (run.id !== id)
        throw new Error(`Workflow run ${id} does not match its document id.`);
    validateRun(coreRoot, run);
    return run;
}
export function writeRun(projectRoot, coreRoot, run) {
    validateRun(coreRoot, run);
    const path = runPath(projectRoot, run.id);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, stringify(run));
}
export function listRuns(projectRoot, coreRoot) {
    const dir = join(projectRoot, ".paved/generated/runs");
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
        .map((entry) => entry.name.slice(0, -".yaml".length))
        .sort()
        .flatMap((id) => readRun(projectRoot, coreRoot, id) ?? []);
}
export const isOpen = (run) => !TERMINAL_STATUSES.has(run.status);
/** The command that created the run, from its id prefix: `intent`, or `feature` / `fix` / `refactor` for 1.x runs. */
export function runCommand(run) {
    return run.id.slice(0, run.id.indexOf("-"));
}
