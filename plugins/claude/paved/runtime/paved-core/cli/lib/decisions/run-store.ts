import { listRuns, readRun, writeRun, type Run } from "../workflow-runs.ts";
import type { Decision } from "./record.ts";

export type DecisionRun = Run;

export function readDecisionRun(projectRoot: string, coreRoot: string, id: string): DecisionRun | undefined {
  return readRun(projectRoot, coreRoot, id);
}

export function writeDecisionRun(projectRoot: string, coreRoot: string, run: DecisionRun): void {
  writeRun(projectRoot, coreRoot, run);
}

export function listRunDecisions(projectRoot: string, coreRoot: string): Decision[] {
  return listRuns(projectRoot, coreRoot).flatMap((run) => run.decisions ?? []);
}

export function readRunDecision(projectRoot: string, coreRoot: string, id: string): Decision | undefined {
  return listRunDecisions(projectRoot, coreRoot).find((decision) => decision.id === id);
}
