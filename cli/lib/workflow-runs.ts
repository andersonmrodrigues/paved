import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";
import { assessRun, type WorkflowContract, type WorkflowRunRecord } from "./workflows.ts";
import type { Decision } from "./decisions/record.ts";

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "blocked";
export interface Gate { id: string; status: string; reason?: string; requested_at?: string; decided_by?: string; decided_at?: string }
export interface Failure { code: string; phase: string; reason: string; retry: string; next_action: string }
export interface Phase { phase: string; status: PhaseStatus; attempts?: number; gates?: Gate[]; failure?: Failure }
export interface RunEvent { at: string; type: string; phase?: string; ref?: string; detail?: string }
export interface RunInput { id: string; value: string; source: "human" | "ticket" | "repository" }
export interface Classification { workflow?: string; because?: string; decided_by?: "agent" | "human"; decision?: string; parts?: string[] }
export interface Run {
  apiVersion: "paved/v1"; kind: "WorkflowRun"; id: string;
  workflow?: { id: string; version: string };
  classification?: Classification;
  revision: string; started_at: string; status: string;
  inputs: RunInput[]; phases: Phase[];
  decisions?: Decision[];
  ended_at?: string; evidence?: string; failure?: Failure;
  events: RunEvent[];
}

/** `failed` is not terminal: a failed phase may be retried. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "completed-with-warnings", "blocked", "cancelled"]);

export function runPath(projectRoot: string, id: string): string {
  if (!/^[a-z][a-z0-9-]{5,80}$/.test(id)) throw new Error(`Invalid workflow run id: ${id}.`);
  return resolveSafePath(projectRoot, `.paved/generated/runs/${id}.yaml`);
}

export function coreWorkflowIds(coreRoot: string): string[] {
  const root = join(coreRoot, "core/workflows");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "workflow.yaml")))
    .map((entry) => `core.${entry.name}`)
    .sort();
}

export function loadContract(coreRoot: string, workflowId: string): WorkflowContract {
  const name = /^core\.([a-z][a-z0-9-]*)$/.exec(workflowId)?.[1];
  if (!name) throw new Error(`Workflow ${workflowId} is not a Core workflow.`);
  const path = join(coreRoot, "core/workflows", name, "workflow.yaml");
  if (!existsSync(path)) throw new Error(`Workflow ${workflowId} does not exist in this Core.`);
  const contract = loadYaml(path) as WorkflowContract;
  if (contract.id !== workflowId) throw new Error(`Workflow file ${name} declares ${contract.id}, not ${workflowId}.`);
  return contract;
}

export function validateRun(coreRoot: string, run: Run): void {
  const schema = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(run);
  if (!schema.valid) throw new Error(`Workflow run ${run.id} is invalid: ${schema.errors.join("; ")}`);
  if (!run.workflow) return;
  const classified = run.classification?.workflow;
  if (classified !== undefined && classified !== run.workflow.id) {
    throw new Error(`Workflow run ${run.id} is classified as ${classified} but runs ${run.workflow.id}.`);
  }
  const record = { ...run, workflow: run.workflow } as unknown as WorkflowRunRecord;
  const problems = assessRun(record, loadContract(coreRoot, run.workflow.id));
  if (problems.length) throw new Error(`Workflow run ${run.id} is inconsistent: ${problems.join("; ")}`);
}

export function readRun(projectRoot: string, coreRoot: string, id: string): Run | undefined {
  const path = runPath(projectRoot, id);
  if (!existsSync(path)) return undefined;
  const run = loadYaml(path) as Run;
  if (run.id !== id) throw new Error(`Workflow run ${id} does not match its document id.`);
  validateRun(coreRoot, run);
  return run;
}

export function writeRun(projectRoot: string, coreRoot: string, run: Run): void {
  validateRun(coreRoot, run);
  const path = runPath(projectRoot, run.id);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, stringify(run));
}

function runIds(projectRoot: string): string[] {
  const dir = join(projectRoot, ".paved/generated/runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name.slice(0, -".yaml".length))
    .sort();
}

export function listRuns(projectRoot: string, coreRoot: string): Run[] {
  return runIds(projectRoot).flatMap((id) => readRun(projectRoot, coreRoot, id) ?? []);
}

export type UnreadableRun = { readonly id: string; readonly reason: string };

/** Like listRuns, but keeps reading past a run document that cannot be read and reports it. */
export function scanRuns(projectRoot: string, coreRoot: string): { runs: Run[]; unreadable: UnreadableRun[] } {
  const runs: Run[] = [];
  const unreadable: UnreadableRun[] = [];
  for (const id of runIds(projectRoot)) {
    try {
      const run = readRun(projectRoot, coreRoot, id);
      if (run) runs.push(run);
    } catch (error) {
      unreadable.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { runs, unreadable };
}

export const isOpen = (run: Pick<Run, "status">): boolean => !TERMINAL_STATUSES.has(run.status);

/** The command that created the run, from its id prefix: `intent`, or `feature` / `fix` / `refactor` for 1.x runs. */
export function runCommand(run: Pick<Run, "id">): string {
  return run.id.slice(0, run.id.indexOf("-"));
}
