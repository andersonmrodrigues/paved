import type { DecisionProjection } from "../../result.ts";
import { acquireConsumerOperationLock } from "../operation-lock.ts";
import { validateAnswer, type AnswerValue } from "./answers.ts";
import { readDecisionApproval } from "./approval.ts";
import { tierFor, type EffectClass } from "./effects.ts";
import { fingerprintOf, supersede } from "./fingerprint.ts";
import {
  decisionId, transition,
  type Decision, type DecisionEvidence, type DecisionOption, type RequiredAnswer,
} from "./record.ts";
import { listDecisions, readDecision, writeDecision } from "./store.ts";

export interface DecisionContext {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly command: string;
  readonly run?: string;
  readonly answers: readonly string[];
  readonly answeredBy?: string;
}

export interface DecisionCandidate {
  readonly scope: "project" | "run";
  readonly question: string;
  readonly reason: string;
  readonly options: readonly DecisionOption[];
  readonly recommended?: string;
  readonly evidence: readonly DecisionEvidence[];
  readonly required: boolean;
  readonly requiredAnswer: RequiredAnswer;
  readonly effect: EffectClass;
  /** Key into the handler map; the handler's registered effect class governs the channel. */
  readonly handler: string;
  /** The candidate set that, with the evidence, identifies and fingerprints this decision. */
  readonly candidates: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly planApproval?: boolean;
}

export type DecisionProvider = (context: DecisionContext) => readonly DecisionCandidate[];

export interface HandlerRegistration {
  readonly effect: EffectClass;
  readonly apply: (answer: AnswerValue, context: DecisionContext) => readonly string[];
  readonly reject?: (answer: AnswerValue) => boolean;
}

export interface DecisionGateOutcome {
  readonly status: "continue" | "awaiting-input";
  readonly projections: DecisionProjection[];
  readonly applied: Decision[];
  readonly problems: string[];
}

export interface DecisionStorage {
  readonly list: () => Decision[];
  readonly read: (id: string) => Decision | undefined;
  readonly write: (decision: Decision) => void;
}

const now = () => new Date().toISOString();

export function toProjection(decision: Decision): DecisionProjection {
  return {
    id: decision.id,
    question: decision.question,
    reason: decision.reason,
    options: decision.options,
    ...(decision.recommended_option === undefined ? {} : { recommended: decision.recommended_option }),
    evidence: decision.evidence,
    required: decision.required,
    risk: decision.risk,
    reversibility: decision.reversibility,
    answerChannel: decision.answer_channel,
    ...(decision.depends_on === undefined ? {} : { dependsOn: decision.depends_on }),
    ...(decision.run === undefined ? {} : { runId: decision.run }),
  };
}

function scopeKey(candidate: DecisionCandidate, context: DecisionContext): string {
  return candidate.scope === "run"
    ? `run:${context.run ?? ""}:${context.command}`
    : `project:${context.command}`;
}

function materialize(candidate: DecisionCandidate, context: DecisionContext, effect: EffectClass): Decision {
  const tier = tierFor(effect, { planApproval: candidate.planApproval === true });
  const id = decisionId(candidate.question, scopeKey(candidate, context), candidate.candidates);
  return {
    apiVersion: "paved/v1",
    kind: "Decision",
    id,
    scope: candidate.scope,
    command: context.command,
    ...(candidate.scope === "run" && context.run !== undefined ? { run: context.run } : {}),
    category: "material",
    authored_by: "runtime",
    question: candidate.question,
    reason: candidate.reason,
    options: candidate.options,
    ...(candidate.recommended === undefined ? {} : { recommended_option: candidate.recommended }),
    evidence: candidate.evidence,
    required: candidate.required,
    required_answer: candidate.requiredAnswer,
    risk: tier.risk,
    reversibility: tier.reversibility,
    answer_channel: tier.channel,
    effect,
    handler: candidate.handler,
    ...(candidate.dependsOn === undefined ? {} : { depends_on: candidate.dependsOn }),
    status: "PENDING",
    fingerprint: fingerprintOf(candidate.evidence, candidate.candidates),
    created_at: now(),
  };
}

const RESOLVED = new Set(["APPLIED", "REJECTED"]);

export function runDecisionGate(input: {
  readonly context: DecisionContext;
  readonly providers: readonly DecisionProvider[];
  readonly handlers: ReadonlyMap<string, HandlerRegistration>;
  readonly persist: boolean;
  readonly storage?: DecisionStorage;
}): DecisionGateOutcome {
  const release = input.persist
    ? acquireConsumerOperationLock(input.context.projectRoot, `decision:${input.context.command}`)
    : undefined;
  try {
    return runDecisionGateUnlocked(input);
  } finally {
    release?.();
  }
}

function runDecisionGateUnlocked(input: {
  readonly context: DecisionContext;
  readonly providers: readonly DecisionProvider[];
  readonly handlers: ReadonlyMap<string, HandlerRegistration>;
  readonly persist: boolean;
  readonly storage?: DecisionStorage;
}): DecisionGateOutcome {
  const { context, providers, handlers, persist } = input;
  const storage = input.storage ?? {
    list: () => listDecisions(context.projectRoot, context.coreRoot),
    read: (id: string) => readDecision(context.projectRoot, context.coreRoot, id),
    write: (decision: Decision) => writeDecision(context.projectRoot, context.coreRoot, decision),
  };
  const problems: string[] = [];
  const applied: Decision[] = [];

  // 1. LOAD
  const stored = new Map(storage.list().map((item) => [item.id, item]));

  // 5. DETECT (run first so current evidence is available for revalidation)
  const candidates = providers.flatMap((provider) => provider(context));
  const current = new Map<string, { candidate: DecisionCandidate; decision: Decision }>();
  for (const candidate of candidates) {
    const decision = materialize(candidate, context,
      handlers.get(candidate.handler)?.effect ?? candidate.effect);
    current.set(decision.id, { candidate, decision });
  }

  // A runtime update can replace a question while keeping its apply handler.
  // Retire the old pending answer contract before it can be shown by status or
  // resumed with options that no longer describe the current behavior.
  for (const old of stored.values()) {
    if (old.status === "SUPERSEDED" || old.status === "CANCELLED" || old.status === "REJECTED") continue;
    if (current.has(old.id)) continue;
    const replacements = [...current.values()].filter(({ decision }) =>
      decision.scope === old.scope && decision.command === old.command
      && decision.run === old.run && decision.handler === old.handler
      && decision.question !== old.question);
    if (replacements.length !== 1) continue;
    const replacement = replacements[0]!;
    const retired = supersede(old, "The runtime replaced this question and its answer options.", replacement.decision.id);
    if (persist) storage.write(retired);
    stored.set(old.id, retired);
    if (replacement.decision.supersedes === undefined) {
      current.set(replacement.decision.id, {
        ...replacement,
        decision: { ...replacement.decision, supersedes: old.id },
      });
    }
  }

  const live = new Map<string, Decision>();
  for (const [id, { candidate, decision }] of current) {
    const relevant = [...stored.values()].filter((item) =>
      item.scope === decision.scope && item.command === decision.command
      && item.run === decision.run && item.question === decision.question
      && item.status !== "SUPERSEDED" && item.status !== "CANCELLED");
    const existing = relevant.find((item) => item.id === id) ?? relevant.at(-1);
    if (existing === undefined) {
      live.set(id, decision);
      continue;
    }
    // 2. REVALIDATE — narrow fingerprint; a mismatch supersedes even an APPLIED decision.
    const fingerprint = fingerprintOf(candidate.evidence, candidate.candidates);
    if (existing.fingerprint.sha256 !== fingerprint.sha256) {
      const successorId = decisionId(candidate.question, scopeKey(candidate, context),
        [...candidate.candidates, fingerprint.sha256]);
      const successor = { ...decision, id: successorId, supersedes: existing.id };
      const superseded = supersede(existing, "Cited evidence or candidate set changed.", successor.id);
      if (persist) {
        storage.write(superseded);
      }
      stored.set(existing.id, superseded);
      live.set(successor.id, successor);
      continue;
    }
    live.set(existing.id, existing);
  }

  // A crash after a handler wrote its configuration can make its provider disappear
  // before APPLIED was recorded. Resume the durable ANSWERED transaction anyway.
  for (const decision of stored.values()) {
    if (decision.command === context.command && decision.status === "ANSWERED"
      && !live.has(decision.id)) live.set(decision.id, decision);
  }

  // 3. ANSWER
  const answers = new Map<string, string[]>();
  for (const entry of context.answers) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const id = entry.slice(0, separator);
    answers.set(id, [...(answers.get(id) ?? []), entry.slice(separator + 1)]);
  }

  {
    for (const [id, values] of answers) {
      let decision = live.get(id) ?? stored.get(id) ?? storage.read(id);
      if (decision === undefined) {
        problems.push(`Unknown decision: ${id}.`);
        continue;
      }
      // Replay: the same value is an idempotent no-op; a different value must go through revise.
      if (RESOLVED.has(decision.status)) {
        const validated = validateAnswer(decision, values);
        if ("problems" in validated) { problems.push(...validated.problems); continue; }
        if (JSON.stringify(validated.value) !== JSON.stringify(decision.answer)) {
          problems.push(`Decision ${id} is already ${decision.status}. Use paved decision revise ${id}.`);
        }
        continue;
      }

      if (decision.status === "PENDING" && live.get(id) === decision && !stored.has(id)
        && (decision.depends_on ?? []).every((dependency) => {
          const resolved = live.get(dependency) ?? stored.get(dependency);
          return resolved !== undefined && RESOLVED.has(resolved.status);
        })) {
        decision = transition(decision, "ASKED", { asked_at: now() });
        live.set(id, decision);
        if (persist) storage.write(decision);
      }
      if (decision.status === "PENDING" || decision.status === "SUPERSEDED"
        || decision.status === "CANCELLED") {
        problems.push(`Decision ${id} is ${decision.status} and cannot be answered.`);
        continue;
      }

      const registration = decision.handler === undefined ? undefined : handlers.get(decision.handler);
      if (registration === undefined || registration.effect !== decision.effect) {
        problems.push(`Decision ${id} has no matching registered apply handler.`);
        continue;
      }

      const asked = decision;
      const validated = validateAnswer(asked, values);
      if ("problems" in validated) {
        problems.push(...validated.problems);
        live.set(id, asked);
        if (persist) storage.write(asked);
        continue;
      }

      // Irreversible decisions require a human-authored approval file; a relayed answer
      // never satisfies them.
      let source: Decision["answer_source"] = "agent-relayed";
      let identity = context.answeredBy;
      if (asked.answer_channel === "human-authored") {
        const approval = readDecisionApproval(context.projectRoot, asked);
        if (approval === undefined) {
          problems.push(
            `Decision ${id} is irreversible. A person must author .paved/approvals/${id}.json.`,
          );
          live.set(id, asked);
          if (persist) storage.write(asked);
          continue;
        }
        if (JSON.stringify(approval.answer) !== JSON.stringify(validated.value)) {
          problems.push(`Approval for decision ${id} does not match the submitted answer.`);
          live.set(id, asked);
          continue;
        }
        source = "human-authored";
        identity = approval.decided_by;
      }
      if (identity === undefined) { problems.push(`Decision ${id} has no answering identity.`); continue; }

      if (registration.reject?.(validated.value) === true) {
        const rejected = transition(asked, "REJECTED", {
          answer: validated.value, answered_by: identity, answer_source: source, answered_at: now(),
        });
        if (persist) storage.write(rejected);
        live.set(id, rejected);
        continue;
      }

      const answered = transition(asked, "ANSWERED", {
        answer: validated.value, answered_by: identity, answer_source: source, answered_at: now(),
      });
      if (persist) storage.write(answered);
      live.set(id, answered);
    }

    // 4. MATERIALIZE — ANSWERED is durable before the mutation; APPLIED after. A crash in
    // between re-applies on the next run, which is why handlers must be idempotent.
    for (const [id, decision] of live) {
      if (decision.status !== "ANSWERED") continue;
      const registration = decision.handler === undefined ? undefined : handlers.get(decision.handler);
      if (registration === undefined) continue;
      if (registration.effect !== decision.effect) {
        problems.push(`Handler ${decision.handler} has a different effect class than decision ${id}.`);
        continue;
      }
      const changes = registration.apply(decision.answer as AnswerValue, context);
      const done = transition(decision, "APPLIED", {
        applied_changes: changes, applied_at: now(),
      });
      if (persist) storage.write(done);
      live.set(id, done);
      applied.push(done);
    }
  }

  // 6. SEQUENCE — a decision whose dependencies are unresolved is never emitted.
  const resolvedIds = new Set([...live.values()].filter((item) => RESOLVED.has(item.status)).map((item) => item.id));
  const emitted: Decision[] = [];
  for (const [id, decision] of live) {
    if (RESOLVED.has(decision.status) || decision.status === "SUPERSEDED" || decision.status === "CANCELLED") continue;
    if ((decision.depends_on ?? []).some((dependency) => !resolvedIds.has(dependency))) {
      if (persist && decision.status === "PENDING") storage.write(decision);
      continue;
    }
    const asked = decision.status === "PENDING"
      ? transition(decision, "ASKED", { asked_at: now() })
      : decision;
    if (persist) storage.write(asked);
    live.set(id, asked);
    emitted.push(asked);
  }

  // 7. VERDICT
  const blocking = emitted.some((decision) => decision.required);
  return {
    status: blocking ? "awaiting-input" : "continue",
    projections: emitted.map(toProjection),
    applied,
    problems,
  };
}
