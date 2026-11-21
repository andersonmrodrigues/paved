import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { localApprover } from "./local-identity.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";

export interface DeliveryApproval {
  readonly apiVersion: "paved/v1";
  readonly kind: "DeliveryApproval";
  readonly target: string;
  readonly change: string;
  readonly head: string;
  readonly patch_id: string;
  readonly approved_by: string;
  readonly approved_at: string;
}

export interface DeliveryAction {
  readonly target: string;
  readonly change: string;
  readonly head: string;
  readonly patch_id: string;
}

const RESERVED_IDENTITIES = new Set(["agent", "paved", "ci", "human"]);

export function deliveryApprovalProblem(
  value: unknown,
  expected: DeliveryAction,
  coreRoot?: string,
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "The delivery approval is invalid.";
  const approval = value as Partial<DeliveryApproval>;
  if (coreRoot !== undefined) {
    const schema = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(value);
    if (!schema.valid) return `The delivery approval is invalid: ${schema.errors.join("; ")}.`;
  } else if (approval.apiVersion !== "paved/v1" || approval.kind !== "DeliveryApproval"
    || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(approval.head ?? "")
    || !/^[a-f0-9]{40}$/.test(approval.patch_id ?? "")
    || typeof approval.approved_by !== "string" || typeof approval.approved_at !== "string") {
    return "The delivery approval is invalid.";
  }
  if (typeof approval.approved_by !== "string" || approval.approved_by.trim().length === 0
    || RESERVED_IDENTITIES.has(approval.approved_by.trim().toLowerCase())) {
    return "The delivery approval has no valid human identity.";
  }
  if (approval.target !== expected.target) return "The approval names a different target.";
  if (approval.change !== expected.change) return "The approval names a different change request.";
  if (approval.head !== expected.head) return "The approval names a different head.";
  if (approval.patch_id !== expected.patch_id) return "The approval names a different patch.";
  return undefined;
}

export function deliveryApprovalPath(action: DeliveryAction): string {
  const digest = createHash("sha256").update(JSON.stringify([action.target, action.change, action.head, action.patch_id])).digest("hex");
  return `.paved/approvals/delivery/${digest}.yaml`;
}

export function writeDeliveryApproval(
  projectRoot: string,
  action: DeliveryAction,
  coreRoot?: string,
): { path: string; approval: DeliveryApproval } {
  const approval: DeliveryApproval = {
    apiVersion: "paved/v1",
    kind: "DeliveryApproval",
    ...action,
    approved_by: localApprover(),
    approved_at: new Date().toISOString(),
  };
  const approvalProblem = deliveryApprovalProblem(approval, action, coreRoot);
  if (approvalProblem) throw new Error(approvalProblem);
  const relative = deliveryApprovalPath(action);
  const path = resolveSafePath(projectRoot, relative);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = loadYaml(path);
    const problem = deliveryApprovalProblem(existing, action, coreRoot);
    if (problem) throw new Error(problem);
    return { path: relative, approval: existing as DeliveryApproval };
  }
  atomicWriteFileSync(path, `${stringify(approval)}\n`);
  return { path: relative, approval };
}

export function readDeliveryApproval(projectRoot: string, coreRoot: string, path: string): DeliveryApproval {
  const absolute = resolveSafePath(projectRoot, path);
  if (!existsSync(absolute)) throw new Error(`Delivery approval does not exist: ${path}.`);
  const approval = loadYaml(absolute);
  const problem = deliveryApprovalProblem(approval, approval as DeliveryAction, coreRoot);
  if (problem) throw new Error(problem);
  return approval as DeliveryApproval;
}
