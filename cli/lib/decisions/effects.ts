import type { AnswerChannel, DecisionReversibility, DecisionRisk, EffectClass } from "./record.ts";

export type { EffectClass };

export interface EffectTier {
  readonly risk: DecisionRisk;
  readonly reversibility: DecisionReversibility;
  readonly channel: AnswerChannel;
}

/**
 * The answer channel is derived from the apply handler's registered effect class, never
 * from a field the caller supplies (spec 6.1). An agent that chooses a handler also
 * chooses its channel, and cannot select a weaker one.
 */
export const EFFECT_TIERS: Readonly<Record<EffectClass, EffectTier>> = {
  "record-only": { risk: "low", reversibility: "reversible", channel: "relayed" },
  "config-additive": { risk: "low", reversibility: "reversible", channel: "relayed" },
  "config-mutating": { risk: "medium", reversibility: "recoverable", channel: "relayed" },
  "lock-transaction": { risk: "medium", reversibility: "recoverable", channel: "relayed" },
  "repository-mutating": { risk: "high", reversibility: "irreversible", channel: "human-authored" },
  destructive: { risk: "high", reversibility: "irreversible", channel: "human-authored" },
};

/** Effect classes an agent-raised decision may reference. */
export const AGENT_ASSIGNABLE_EFFECTS: ReadonlySet<EffectClass> = new Set<EffectClass>([
  "record-only",
]);

export function tierFor(effect: EffectClass, options: { planApproval?: boolean } = {}): EffectTier {
  const tier = EFFECT_TIERS[effect];
  return options.planApproval === true ? { ...tier, channel: "human-authored" } : tier;
}
