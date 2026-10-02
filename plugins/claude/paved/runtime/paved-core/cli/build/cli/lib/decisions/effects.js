/**
 * The answer channel is derived from the apply handler's registered effect class, never
 * from a field the caller supplies (spec 6.1). An agent that chooses a handler also
 * chooses its channel, and cannot select a weaker one.
 */
const effectTiersTable = {
    "record-only": { risk: "low", reversibility: "reversible", channel: "relayed" },
    "config-additive": { risk: "low", reversibility: "reversible", channel: "relayed" },
    "config-mutating": { risk: "medium", reversibility: "recoverable", channel: "relayed" },
    "lock-transaction": { risk: "medium", reversibility: "recoverable", channel: "relayed" },
    "repository-mutating": { risk: "high", reversibility: "irreversible", channel: "human-authored" },
    destructive: { risk: "high", reversibility: "irreversible", channel: "human-authored" },
};
// Freeze each tier object to prevent runtime mutations
for (const tier of Object.values(effectTiersTable))
    Object.freeze(tier);
Object.freeze(effectTiersTable);
export const EFFECT_TIERS = effectTiersTable;
/** Effect classes an agent-raised decision may reference. */
export const AGENT_ASSIGNABLE_EFFECTS = new Set([
    "record-only",
]);
export function tierFor(effect, options = {}) {
    const tier = EFFECT_TIERS[effect];
    if (tier === undefined)
        throw new Error(`Unknown effect class: ${effect}`);
    return { ...tier, ...(options.planApproval === true ? { channel: "human-authored" } : {}) };
}
