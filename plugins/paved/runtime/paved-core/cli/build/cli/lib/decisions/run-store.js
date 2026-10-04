import { listRuns, readRun, writeRun } from "../workflow-runs.js";
export function readDecisionRun(projectRoot, coreRoot, id) {
    return readRun(projectRoot, coreRoot, id);
}
export function writeDecisionRun(projectRoot, coreRoot, run) {
    writeRun(projectRoot, coreRoot, run);
}
export function listRunDecisions(projectRoot, coreRoot) {
    return listRuns(projectRoot, coreRoot).flatMap((run) => run.decisions ?? []);
}
export function readRunDecision(projectRoot, coreRoot, id) {
    return listRunDecisions(projectRoot, coreRoot).find((decision) => decision.id === id);
}
