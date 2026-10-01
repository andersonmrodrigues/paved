import { createHash } from "node:crypto";
import { transition, type Decision, type DecisionEvidence, type DecisionFingerprint } from "./record.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// Terminal states that are not re-openable: superseding them again would churn the
// audit trail without changing anything.
const IMMUTABLE = new Set(["SUPERSEDED", "CANCELLED", "REJECTED"]);

/**
 * The narrowness rule (spec 2.4): a fingerprint digests ONLY the decision's own cited
 * evidence and its candidate set — never the whole source tree. A broad fingerprint
 * would supersede and re-ask every answered question on any unrelated commit, which
 * would violate the question-efficiency requirement.
 */
export function fingerprintOf(
  evidence: readonly DecisionEvidence[],
  candidates: readonly string[],
): DecisionFingerprint {
  const inputs = [
    ...evidence.map((item) => `evidence:${item.location}@${item.sha256}`),
    ...candidates.map((id) => `candidate:${id}`),
  ].sort((a, b) => a.localeCompare(b, "en"));
  return { inputs, sha256: sha(inputs.join("\n")) };
}

export function isStale(decision: Decision, current: DecisionFingerprint): boolean {
  if (IMMUTABLE.has(decision.status)) return false;
  return decision.fingerprint.sha256 !== current.sha256;
}

export function supersede(decision: Decision, reason: string, successorId: string): Decision {
  return transition(decision, "SUPERSEDED", {
    superseded_by: successorId,
    superseded_reason: reason,
  });
}
