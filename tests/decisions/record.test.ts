import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../../cli/lib/schemas.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const registry = () => createRegistry(join(root, "schemas"), ["paved/v1"]);

function minimalDecision(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "paved/v1",
    kind: "Decision",
    id: "d-0123456789abcdef0123",
    scope: "project",
    command: "verify",
    category: "material",
    authored_by: "runtime",
    question: "Should the detected checks become verification gates?",
    reason: "These checks already run in CI but are not authorized as Paved gates.",
    options: [
      { id: "all", label: "All", description: "Adopt every detected check.", consequence: "All detected checks become gates." },
      { id: "none", label: "None", description: "Adopt nothing.", consequence: "No verification profile is created." },
    ],
    evidence: [{ type: "file", location: "pom.xml", sha256: "a".repeat(64) }],
    required: true,
    required_answer: { type: "single-choice" },
    risk: "low",
    reversibility: "reversible",
    answer_channel: "relayed",
    status: "PENDING",
    fingerprint: { inputs: ["pom.xml@" + "a".repeat(64)], sha256: "b".repeat(64) },
    created_at: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("Decision schema", () => {
  it("accepts a minimal valid decision", () => {
    const result = registry().validate(minimalDecision());
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("rejects an id that is not the canonical decision id form", () => {
    assert.equal(registry().validate(minimalDecision({ id: "../escape" })).valid, false);
  });

  it("rejects answered_by values reserved for non-humans", () => {
    const decision = minimalDecision({
      status: "ANSWERED",
      answer: "all",
      answered_by: "agent",
      answer_source: "agent-relayed",
      answered_at: "2026-09-28T00:01:00.000Z",
    });
    assert.equal(registry().validate(decision).valid, false);
  });

  it("requires answer provenance once the decision is ANSWERED", () => {
    assert.equal(registry().validate(minimalDecision({ status: "ANSWERED" })).valid, false);
  });

  it("requires at least one evidence entry when a recommendation is present", () => {
    const decision = minimalDecision({ recommended_option: "all", evidence: [] });
    assert.equal(registry().validate(decision).valid, false);
  });

  it("accepts a decision with a handler", () => {
    const result = registry().validate(minimalDecision({ handler: "verification.adopt" }));
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("accepts each valid effect class value through schema validation", () => {
    const effectValues = ["record-only", "config-additive", "config-mutating", "lock-transaction", "repository-mutating", "destructive"] as const;
    for (const effect of effectValues) {
      const result = registry().validate(minimalDecision({ effect }));
      assert.equal(result.valid, true, `effect: ${effect} failed validation: ${result.errors.join("; ")}`);
    }
  });

  it("rejects an invalid effect value", () => {
    const result = registry().validate(minimalDecision({ effect: "not-an-effect" as never }));
    assert.equal(result.valid, false);
  });

  it("requires run when scope is run", () => {
    const decision = minimalDecision({ scope: "run" });
    assert.equal(registry().validate(decision).valid, false);
  });

  it("requires applied_at once the decision is APPLIED", () => {
    const decision = minimalDecision({
      status: "APPLIED",
      answer: "all",
      answered_by: "owner",
      answer_source: "human-authored",
      answered_at: "2026-09-28T00:01:00.000Z",
    });
    assert.equal(registry().validate(decision).valid, false);
  });

  it("requires superseded_reason once the decision is SUPERSEDED", () => {
    const decision = minimalDecision({ status: "SUPERSEDED" });
    assert.equal(registry().validate(decision).valid, false);
  });
});

import { canTransition, decisionId, DecisionStateError, transition } from "../../cli/lib/decisions/record.ts";

describe("decision id derivation", () => {
  it("is stable for the same question, scope and candidate set", () => {
    const a = decisionId("Adopt checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    const b = decisionId("Adopt checks?", "project:verify", ["mvn-test", "mvn-validate"]);
    assert.equal(a, b, "candidate order must not change the id");
    assert.match(a, /^d-[a-f0-9]{20}$/);
  });

  it("differs when the candidate set differs", () => {
    const a = decisionId("Adopt checks?", "project:verify", ["mvn-validate"]);
    const b = decisionId("Adopt checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    assert.notEqual(a, b);
  });
});

describe("decision state machine", () => {
  it("allows the happy path", () => {
    assert.equal(canTransition("PENDING", "ASKED"), true);
    assert.equal(canTransition("ASKED", "ANSWERED"), true);
    assert.equal(canTransition("ANSWERED", "APPLIED"), true);
  });

  it("forbids skipping ASKED", () => {
    assert.equal(canTransition("PENDING", "ANSWERED"), false);
  });

  it("forbids leaving terminal states except by supersession", () => {
    assert.equal(canTransition("APPLIED", "ANSWERED"), false);
    assert.equal(canTransition("APPLIED", "SUPERSEDED"), true);
    assert.equal(canTransition("REJECTED", "SUPERSEDED"), false);
    assert.equal(canTransition("CANCELLED", "ASKED"), false);
  });

  it("throws on an illegal transition and does not mutate the input", () => {
    const decision = { ...minimalDecision(), status: "APPLIED" } as never;
    assert.throws(() => transition(decision, "ASKED"), DecisionStateError);
    assert.equal((decision as { status: string }).status, "APPLIED");
  });

  it("returns a new record carrying the patch", () => {
    const decision = minimalDecision() as never;
    const asked = transition(decision, "ASKED", { asked_at: "2026-09-28T00:02:00.000Z" });
    assert.equal(asked.status, "ASKED");
    assert.equal(asked.asked_at, "2026-09-28T00:02:00.000Z");
    assert.equal((decision as { status: string }).status, "PENDING");
  });
});
