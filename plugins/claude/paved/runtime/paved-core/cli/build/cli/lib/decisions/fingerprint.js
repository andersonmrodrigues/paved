import { createHash } from "node:crypto";
import { transition } from "./record.js";
const sha = (value) => createHash("sha256").update(value).digest("hex");
// Terminal states that are not re-openable: superseding them again would churn the
// audit trail without changing anything.
const IMMUTABLE = new Set(["SUPERSEDED", "CANCELLED", "REJECTED"]);
/**
 * The narrowness rule (spec 2.4): a fingerprint digests ONLY the decision's own cited
 * evidence and its candidate set — never the whole source tree. A broad fingerprint
 * would supersede and re-ask every answered question on any unrelated commit, which
 * would violate the question-efficiency requirement.
 */
export function fingerprintOf(evidence, candidates) {
    const inputs = [
        ...evidence.map((item) => `evidence:${item.location}@${item.sha256}`),
        ...candidates.map((id) => `candidate:${id}`),
    ].sort((a, b) => a.localeCompare(b, "en"));
    return { inputs, sha256: sha(inputs.join("\n")) };
}
export function isStale(decision, current) {
    if (IMMUTABLE.has(decision.status))
        return false;
    return decision.fingerprint.sha256 !== current.sha256;
}
export function supersede(decision, reason, successorId) {
    return transition(decision, "SUPERSEDED", {
        superseded_by: successorId,
        superseded_reason: reason,
    });
}
