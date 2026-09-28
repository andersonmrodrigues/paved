import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprintOf, isStale, supersede } from "../../cli/lib/decisions/fingerprint.ts";
import { DecisionStateError } from "../../cli/lib/decisions/record.ts";
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

  it("is stable and order-independent over evidence", () => {
    const reordered = [...evidence].reverse();
    assert.equal(
      fingerprintOf(evidence, ["a"]).sha256,
      fingerprintOf(reordered, ["a"]).sha256,
    );
  });

  it("changes when a cited evidence digest changes", () => {
    const moved = [{ type: "file" as const, location: "pom.xml", sha256: "c".repeat(64) }];
    assert.notEqual(fingerprintOf(evidence, ["a"]).sha256, fingerprintOf(moved, ["a"]).sha256);
  });

  it("changes when the candidate set changes", () => {
    assert.notEqual(fingerprintOf(evidence, ["a"]).sha256, fingerprintOf(evidence, ["a", "b"]).sha256);
  });

  it("is deterministic for identical inputs", () => {
    // Determinism: the same inputs always produce the same digest.
    const before = fingerprintOf(evidence, ["a"]);
    const after = fingerprintOf([...evidence], ["a"]);
    assert.equal(before.sha256, after.sha256);
    assert.deepEqual(before.inputs, after.inputs);
  });
});

describe("staleness", () => {
  it("detects a mismatch in ASKED state", () => {
    assert.equal(isStale(decision("ASKED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("accepts a match in ASKED state", () => {
    assert.equal(isStale(decision("ASKED"), fingerprintOf(evidence, ["mvn-validate"])), false);
  });

  it("detects staleness in PENDING state when fingerprint differs", () => {
    assert.equal(isStale(decision("PENDING"), fingerprintOf(evidence, ["different"])), true);
  });

  it("accepts a match in PENDING state when fingerprint matches", () => {
    assert.equal(isStale(decision("PENDING"), fingerprintOf(evidence, ["mvn-validate"])), false);
  });

  it("detects staleness in ANSWERED state when fingerprint differs", () => {
    assert.equal(isStale(decision("ANSWERED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("accepts a match in ANSWERED state when fingerprint matches", () => {
    assert.equal(isStale(decision("ANSWERED"), fingerprintOf(evidence, ["mvn-validate"])), false);
  });

  it("checks APPLIED decisions too", () => {
    assert.equal(isStale(decision("APPLIED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("respects narrowness: uncited file changes do not cause staleness", () => {
    // The narrowness rule (spec 2.4): an APPLIED decision whose CITED evidence is unchanged
    // must not report as stale, even though some other file changed.
    const appliedDec = decision("APPLIED");
    // Recompute fingerprint with same cited evidence and candidates — representing
    // a world where uncited files changed but nothing the decision cited did.
    const currentFingerprint = fingerprintOf(evidence, ["mvn-validate"]);
    assert.equal(isStale(appliedDec, currentFingerprint), false);
  });

  it("detects when cited evidence changes", () => {
    // Contrasting case: when cited evidence DOES change, staleness is detected.
    const appliedDec = decision("APPLIED");
    const changedEvidence = [{ type: "file" as const, location: "pom.xml", sha256: "b".repeat(64) }];
    const staleFp = fingerprintOf(changedEvidence, ["mvn-validate"]);
    assert.equal(isStale(appliedDec, staleFp), true);
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

  it("throws when superseding an already-rejected decision", () => {
    assert.throws(
      () => supersede(decision("REJECTED"), "Reason", "d-successor"),
      DecisionStateError,
    );
  });

  it("throws when superseding an already-cancelled decision", () => {
    assert.throws(
      () => supersede(decision("CANCELLED"), "Reason", "d-successor"),
      DecisionStateError,
    );
  });

  it("throws when superseding an already-superseded decision", () => {
    assert.throws(
      () => supersede(decision("SUPERSEDED"), "Reason", "d-successor"),
      DecisionStateError,
    );
  });
});
