import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_ASSIGNABLE_EFFECTS, EFFECT_TIERS, tierFor } from "../../cli/lib/decisions/effects.ts";

describe("effect class tiering", () => {
  it("routes reversible effects through the relayed channel", () => {
    assert.equal(tierFor("record-only").channel, "relayed");
    assert.equal(tierFor("config-additive").channel, "relayed");
  });

  it("routes recoverable effects through the relayed channel", () => {
    assert.equal(tierFor("config-mutating").channel, "relayed");
    assert.equal(tierFor("lock-transaction").channel, "relayed");
  });

  it("forces irreversible effects onto the human-authored channel", () => {
    assert.equal(tierFor("repository-mutating").channel, "human-authored");
    assert.equal(tierFor("destructive").channel, "human-authored");
  });

  it("forces plan approval onto the human-authored channel regardless of effect", () => {
    // reversible base (record-only is already relayed)
    assert.equal(tierFor("record-only", { planApproval: true }).channel, "human-authored");
    // recoverable base (config-mutating is already relayed)
    assert.equal(tierFor("config-mutating", { planApproval: true }).channel, "human-authored");
    // irreversible base (destructive is already human-authored, override is idempotent)
    assert.equal(tierFor("destructive", { planApproval: true }).channel, "human-authored");
  });

  it("keeps every irreversible tier on the human-authored channel", () => {
    for (const [effect, tier] of Object.entries(EFFECT_TIERS)) {
      if (tier.reversibility === "irreversible") {
        assert.equal(tier.channel, "human-authored", `${effect} must be human-authored`);
      }
    }
  });

  it("does not let an agent assign an irreversible effect class", () => {
    assert.deepEqual([...AGENT_ASSIGNABLE_EFFECTS], ["record-only"]);
  });

  it("throws on unknown effect class instead of returning a malformed tier", () => {
    assert.throws(
      () => tierFor("unknown-effect" as never),
      /Unknown effect class/
    );
  });

  it("prevents mutations of the returned tier from affecting the canonical singleton", () => {
    const tier = tierFor("destructive");
    // Attempt to mutate the returned tier
    (tier as any).channel = "relayed";
    // Verify the mutation did not persist to the canonical entry
    assert.equal(tierFor("destructive").channel, "human-authored");
  });
});
