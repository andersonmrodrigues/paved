import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "../atomic-write.ts";
import { loadYaml } from "../documents.ts";
import { resolveSafePath } from "../safe-path.ts";
import { createRegistry } from "../schemas.ts";
import type { Decision } from "./record.ts";

export class DecisionStoreError extends Error {}

const DECISION_ID = /^d-[a-f0-9]{20}$/;

/** Validates the id before any path construction, closing path traversal (spec 3.3). */
export function decisionPath(projectRoot: string, id: string): string {
  if (!DECISION_ID.test(id)) throw new DecisionStoreError(`Invalid decision id: ${id}`);
  return resolveSafePath(projectRoot, `.paved/decisions/${id}.yaml`);
}

// .paved/decisions/ is committed and human-editable (manifest.yaml: committed: true), so
// content can reach the store without ever passing through writeDecision — a hand edit, a
// bad merge, a stale checkout. Every read re-validates against the schema, mirroring the
// discipline in cli/commands/workflow.ts's approval(): trust nothing that did not just pass
// validation, and never silently treat a corrupt/tampered record as merely absent.
export function readDecision(projectRoot: string, coreRoot: string, id: string): Decision | undefined {
  const path = decisionPath(projectRoot, id);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = loadYaml(path);
  } catch (error) {
    throw new DecisionStoreError(`Decision ${id} cannot be parsed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(raw);
  if (!validation.valid) {
    throw new DecisionStoreError(`Decision ${id} at ${path} failed validation: ${validation.errors.join("; ")}`);
  }
  return raw as Decision;
}

export function listDecisions(projectRoot: string, coreRoot: string): Decision[] {
  const root = join(projectRoot, ".paved/decisions");
  if (!existsSync(root)) return [];
  const decisions: Decision[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const id = entry.name.slice(0, -".yaml".length);
    if (!DECISION_ID.test(id)) continue;
    const decision = readDecision(projectRoot, coreRoot, id);
    if (decision !== undefined) decisions.push(decision);
  }
  return decisions.sort((a, b) =>
    a.created_at.localeCompare(b.created_at, "en") || a.id.localeCompare(b.id, "en"));
}

export function writeDecision(projectRoot: string, coreRoot: string, decision: Decision): void {
  const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(decision);
  if (!validation.valid) {
    throw new DecisionStoreError(`Decision ${decision.id} is invalid: ${validation.errors.join("; ")}`);
  }
  const path = decisionPath(projectRoot, decision.id);
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteFileSync(path, stringify(decision));
}
