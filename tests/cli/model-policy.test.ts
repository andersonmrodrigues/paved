import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recommendModels } from "../../cli/lib/model-policy.ts";

describe("model routing policy", () => {
  const models = [
    { id: "balanced-a", family: "alpha", costTier: "medium" },
    { id: "cheap-a", family: "alpha", costTier: "low" },
    { id: "cheap-b", family: "beta", costTier: "low" },
    { id: "unknown", family: null, costTier: null },
  ] as const;

  it("orders reported models by cost and keeps session as fallback", () => {
    const policy = recommendModels({ models, sessionFamily: "alpha" });
    assert.deepEqual(policy.explorer.candidates, ["cheap-a", "cheap-b", "balanced-a", "unknown", "session"]);
    assert.deepEqual(policy.mechanical.candidates, policy.explorer.candidates);
    assert.deepEqual(policy.implementer.candidates, ["session"]);
    assert.equal(policy.explorer.fallback, "session");
    assert.equal(policy.explorer.requiresHumanDecision, false);
  });

  it("prefers another known family for review and reports the constraint", () => {
    const policy = recommendModels({ models, sessionFamily: "alpha" });
    assert.deepEqual(policy.reviewer.candidates, ["cheap-b", "cheap-a", "balanced-a", "unknown", "session"]);
    assert.equal(policy.reviewer.familyConstraint, "different-family-available");
  });

  it("reports when review diversity is unavailable or unverified", () => {
    const sameFamily = [{ id: "same", family: "alpha", costTier: "low" }] as const;
    assert.equal(recommendModels({ models: sameFamily, sessionFamily: "alpha" }).reviewer.familyConstraint, "different-family-unavailable");
    assert.equal(recommendModels({ models, sessionFamily: null }).reviewer.familyConstraint, "implementer-family-unknown");
    assert.equal(recommendModels({ models: [{ id: "unknown", family: null, costTier: null }], sessionFamily: "alpha" }).reviewer.familyConstraint, "different-family-unverified");
  });

  it("uses the session for independent review when its known family differs", () => {
    const policy = recommendModels({
      models: [{ id: "implementer", family: "beta", costTier: "low" }, { id: "same", family: "beta", costTier: "low" }],
      sessionFamily: "alpha",
      preferences: { implementer: "implementer" },
    });
    assert.deepEqual(policy.reviewer.candidates, ["session"]);
    assert.equal(policy.reviewer.familyConstraint, "different-family-available");
  });

  it("reports unknown host metadata and does not infer a missing session family", () => {
    const policy = recommendModels({ models, sessionFamily: null, preferences: { implementer: "cheap-a" } });
    assert.deepEqual(policy.constraints, {
      sessionFamily: null,
      implementerFamily: "alpha",
      unknownCostModels: ["unknown"],
      unknownFamilyModels: ["unknown"],
    });
    assert.equal(recommendModels({
      models: [{ id: "implementer", family: "beta", costTier: "low" }],
      sessionFamily: null,
      preferences: { implementer: "implementer" },
    }).reviewer.familyConstraint, "different-family-unverified");
  });

  it("preserves available human preferences even when they conflict with the family preference", () => {
    const policy = recommendModels({
      models,
      sessionFamily: "alpha",
      preferences: { implementer: "cheap-b", reviewer: "cheap-b", explorer: "session" },
    });
    assert.deepEqual(policy.implementer.candidates, ["cheap-b", "session"]);
    assert.deepEqual(policy.explorer.candidates, ["session"]);
    assert.equal(policy.reviewer.candidates[0], "cheap-b");
    assert.equal(policy.reviewer.familyConstraint, "preference-same-family");
    assert.equal(policy.reviewer.requiresHumanDecision, false);
  });

  it("does not silently replace an unavailable human preference", () => {
    const policy = recommendModels({ models, sessionFamily: "alpha", preferences: { implementer: "missing", reviewer: "missing" } });
    assert.deepEqual(policy.implementer.candidates, ["session"]);
    assert.equal(policy.implementer.preference, "missing");
    assert.equal(policy.implementer.requiresHumanDecision, true);
    assert.equal(policy.reviewer.requiresHumanDecision, true);
    assert.equal(policy.reviewer.familyConstraint, "implementer-family-unknown");
    assert.ok(!policy.reviewer.candidates.includes("missing"));
    assert.equal(recommendModels({ models, sessionFamily: "alpha", preferences: { reviewer: "missing" } }).reviewer.familyConstraint, "preference-unavailable");
  });

  it("handles no host catalog and does not invent model identities", () => {
    const policy = recommendModels({ models: [], sessionFamily: null });
    for (const role of ["explorer", "implementer", "reviewer", "mechanical"] as const) {
      assert.deepEqual(policy[role].candidates, ["session"]);
    }
  });

  it("uses a stable tie break independent of catalog ordering", () => {
    assert.deepEqual(
      recommendModels({ models, sessionFamily: "alpha" }),
      recommendModels({ models: [...models].reverse(), sessionFamily: "alpha" }),
    );
  });

  it("rejects ambiguous catalog identities", () => {
    assert.throws(() => recommendModels({ models: [models[0], models[0]], sessionFamily: null }), /duplicate/i);
    assert.throws(() => recommendModels({ models: [{ id: "session", family: null, costTier: null }], sessionFamily: null }), /session/i);
    assert.throws(() => recommendModels({ models: [{ id: "", family: null, costTier: null }], sessionFamily: null }), /id/i);
  });
});
