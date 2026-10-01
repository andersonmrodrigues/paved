import { createHash } from "node:crypto";
export class DecisionStateError extends Error {
}
// SUPERSEDED is reachable from every non-terminal state and from APPLIED, because an
// applied decision whose evidence changed must not be silently reused (spec 2.4).
const TRANSITIONS = {
    PENDING: ["ASKED", "CANCELLED", "SUPERSEDED"],
    ASKED: ["ANSWERED", "REJECTED", "CANCELLED", "SUPERSEDED"],
    ANSWERED: ["APPLIED", "SUPERSEDED"],
    APPLIED: ["SUPERSEDED"],
    REJECTED: [],
    CANCELLED: [],
    SUPERSEDED: [],
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
/**
 * Content-derived and order-independent: re-raising the same question against the same
 * candidate set resolves to the same record, which is what makes providers idempotent
 * and lets read-only commands ask without persisting (spec 4).
 */
export function decisionId(question, scope, candidates) {
    const normalized = [...candidates].sort((a, b) => a.localeCompare(b, "en")).join("\n");
    return `d-${sha(`${question}\n${scope}\n${normalized}`).slice(0, 20)}`;
}
export function canTransition(from, to) {
    return TRANSITIONS[from].includes(to);
}
export function transition(decision, to, patch = {}) {
    if (!canTransition(decision.status, to)) {
        throw new DecisionStateError(`Decision ${decision.id} cannot move from ${decision.status} to ${to}.`);
    }
    return { ...decision, ...patch, status: to };
}
