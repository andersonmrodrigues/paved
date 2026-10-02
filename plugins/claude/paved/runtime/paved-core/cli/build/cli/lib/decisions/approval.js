import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveSafePath } from "../safe-path.js";
export class ApprovalError extends Error {
}
const DECISION_ID = /^d-[a-f0-9]{20}$/;
const RESERVED_IDENTITIES = new Set(["agent", "paved", "ci"]);
/** The digest binds the human approval to the exact question and evidence shown. */
export function decisionDigest(decision) {
    return createHash("sha256").update(JSON.stringify({
        id: decision.id,
        question: decision.question,
        options: decision.options,
        evidence: decision.evidence,
    })).digest("hex");
}
export function readDecisionApproval(projectRoot, decision) {
    if (!DECISION_ID.test(decision.id))
        throw new ApprovalError(`Invalid decision id: ${decision.id}`);
    const path = resolveSafePath(projectRoot, `.paved/approvals/${decision.id}.json`);
    if (!existsSync(path))
        return undefined;
    if (decision.status !== "ASKED") {
        throw new ApprovalError(`Approval exists for decision ${decision.id}, which is ${decision.status}, not ASKED.`);
    }
    let document;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid approval object");
        document = parsed;
    }
    catch {
        throw new ApprovalError(`Approval record for ${decision.id} is not valid JSON.`);
    }
    const decidedBy = document.decided_by;
    const decidedAt = document.decided_at;
    if (document.decision !== decision.id
        || document.decision_sha256 !== decisionDigest(decision)
        || typeof decidedBy !== "string" || decidedBy.trim() === "" || RESERVED_IDENTITIES.has(decidedBy)
        || typeof decidedAt !== "string" || Number.isNaN(Date.parse(decidedAt))) {
        throw new ApprovalError(`Approval record for ${decision.id} is invalid or does not match the current decision. `
            + `A person must decide this exact decision in .paved/approvals/${decision.id}.json.`);
    }
    return { answer: document.answer, decided_by: decidedBy, decided_at: decidedAt };
}
