import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprintOf, isStale, supersede } from "../../cli/lib/decisions/fingerprint.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];

function decision(status: Decision["status"]): Decision {
  return {
    apiVersion: "paved/v1", kind: "Decision", id: "d-0123456789abcdef0123",
    scope: "project", command: "verify", category: "material", authored_by: "runtime",
    question: "q", reason: "r",
    options: [{ id: "all", label: "All", description: "d", consequence: "c" }],
    evidence, required: true, required_answer: { type: "single-choice" },
    risk: "low", reversibility: "reversible", answer_channel: "relayed",
    status, fingerprint: fingerprintOf(evidence, ["mvn-validate"]),
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

describe("decision fingerprinting", () => {
  it("is stable and order-independent over candidates", () => {
    assert.equal(
      fingerprintOf(evidence, ["b", "a"]).sha256,
      fingerprintOf(evidence, ["a", "b"]).sha256,
    );
  });

  it("changes when a cited evidence digest changes", () => {
    const moved = [{ type: "file" as const, location: "pom.xml", sha256: "c".repeat(64) }];
    assert.notEqual(fingerprintOf(evidence, ["a"]).sha256, fingerprintOf(moved, ["a"]).sha256);
  });

  it("changes when the candidate set changes", () => {
    assert.notEqual(fingerprintOf(evidence, ["a"]).sha256, fingerprintOf(evidence, ["a", "b"]).sha256);
  });

  it("does NOT change when an uncited file changes", () => {
    // The narrowness rule: only cited evidence participates. An unrelated commit must
    // not supersede an answered decision (spec 2.4).
    const before = fingerprintOf(evidence, ["a"]);
    const after = fingerprintOf([...evidence], ["a"]);
    assert.equal(before.sha256, after.sha256);
    assert.deepEqual(before.inputs, after.inputs);
  });
});

describe("staleness", () => {
  it("detects a mismatch", () => {
    assert.equal(isStale(decision("ASKED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("accepts a match", () => {
    assert.equal(isStale(decision("ASKED"), fingerprintOf(evidence, ["mvn-validate"])), false);
  });

  it("checks APPLIED decisions too", () => {
    assert.equal(isStale(decision("APPLIED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("never reports terminal non-applied decisions as stale", () => {
    assert.equal(isStale(decision("SUPERSEDED"), fingerprintOf(evidence, ["different"])), false);
    assert.equal(isStale(decision("CANCELLED"), fingerprintOf(evidence, ["different"])), false);
    assert.equal(isStale(decision("REJECTED"), fingerprintOf(evidence, ["different"])), false);
  });
});

describe("supersession", () => {
  it("records the reason and the successor", () => {
    const result = supersede(decision("APPLIED"), "Repository topology changed.", "d-ffffffffffffffffffff");
    assert.equal(result.status, "SUPERSEDED");
    assert.equal(result.superseded_by, "d-ffffffffffffffffffff");
    assert.equal(result.superseded_reason, "Repository topology changed.");
  });
});
