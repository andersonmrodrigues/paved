import { createHash } from "node:crypto";

export type DecisionStatus =
  | "PENDING" | "ASKED" | "ANSWERED" | "APPLIED" | "REJECTED" | "CANCELLED" | "SUPERSEDED";
export type DecisionCategory = "deterministic" | "material";
export type DecisionAuthor = "runtime" | "agent";
export type AnswerSource = "derived" | "agent-relayed" | "human-authored";
export type AnswerChannel = "relayed" | "human-authored";
export type DecisionRisk = "low" | "medium" | "high";
export type DecisionReversibility = "reversible" | "recoverable" | "irreversible";
export type RequiredAnswerType = "single-choice" | "multi-choice" | "boolean" | "free-text";

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly consequence: string;
}

export interface DecisionEvidence {
  readonly type: "file";
  readonly location: string;
  readonly sha256: string;
}

export interface RequiredAnswer {
  readonly type: RequiredAnswerType;
  readonly pattern?: string;
  readonly max_length?: number;
}

export interface DecisionFingerprint {
  readonly inputs: readonly string[];
  readonly sha256: string;
}

export interface Decision {
  readonly apiVersion: "paved/v1";
  readonly kind: "Decision";
  readonly id: string;
  readonly scope: "project" | "run";
  readonly command: string;
  readonly run?: string;
  readonly category: DecisionCategory;
  readonly authored_by: DecisionAuthor;
  readonly question: string;
  readonly reason: string;
  readonly options: readonly DecisionOption[];
  readonly recommended_option?: string;
  readonly evidence: readonly DecisionEvidence[];
  readonly required: boolean;
  readonly required_answer: RequiredAnswer;
  readonly risk: DecisionRisk;
  readonly reversibility: DecisionReversibility;
  readonly answer_channel: AnswerChannel;
  readonly effect?: string;
  readonly handler?: string;
  readonly depends_on?: readonly string[];
  readonly status: DecisionStatus;
  readonly asked_at?: string;
  readonly answer?: unknown;
  readonly answered_by?: string;
  readonly answer_source?: AnswerSource;
  readonly answered_at?: string;
  readonly applied_changes?: readonly string[];
  readonly applied_at?: string;
  readonly fingerprint: DecisionFingerprint;
  readonly supersedes?: string;
  readonly superseded_by?: string;
  readonly superseded_reason?: string;
  readonly created_at: string;
}

export class DecisionStateError extends Error {}

// SUPERSEDED is reachable from every non-terminal state and from APPLIED, because an
// applied decision whose evidence changed must not be silently reused (spec 2.4).
const TRANSITIONS: Readonly<Record<DecisionStatus, readonly DecisionStatus[]>> = {
  PENDING: ["ASKED", "CANCELLED", "SUPERSEDED"],
  ASKED: ["ANSWERED", "REJECTED", "CANCELLED", "SUPERSEDED"],
  ANSWERED: ["APPLIED", "SUPERSEDED"],
  APPLIED: ["SUPERSEDED"],
  REJECTED: [],
  CANCELLED: [],
  SUPERSEDED: [],
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Content-derived and order-independent: re-raising the same question against the same
 * candidate set resolves to the same record, which is what makes providers idempotent
 * and lets read-only commands ask without persisting (spec 4).
 */
export function decisionId(question: string, scope: string, candidates: readonly string[]): string {
  const normalized = [...candidates].sort((a, b) => a.localeCompare(b, "en")).join("\n");
  return `d-${sha(`${question}\n${scope}\n${normalized}`).slice(0, 20)}`;
}

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(decision: Decision, to: DecisionStatus, patch: Partial<Decision> = {}): Decision {
  if (!canTransition(decision.status, to)) {
    throw new DecisionStateError(`Decision ${decision.id} cannot move from ${decision.status} to ${to}.`);
  }
  return { ...decision, ...patch, status: to };
}
