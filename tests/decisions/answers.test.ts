import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import {
  AnswerIdentityError, assertAnswerIdentity, parseAnswerFlags, validateAnswer,
} from "../../cli/lib/decisions/answers.ts";
import type { Decision, RequiredAnswerType } from "../../cli/lib/decisions/record.ts";

function decision(type: RequiredAnswerType, extra: Record<string, unknown> = {}): Decision {
  const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];
  return {
    apiVersion: "paved/v1", kind: "Decision", id: "d-0123456789abcdef0123",
    scope: "project", command: "verify", category: "material", authored_by: "runtime",
    question: "q", reason: "r",
    options: [
      { id: "all", label: "All", description: "d", consequence: "c" },
      { id: "backend", label: "Backend", description: "d", consequence: "c" },
    ],
    evidence, required: true,
    required_answer: { type, ...extra } as Decision["required_answer"],
    risk: "low", reversibility: "reversible", answer_channel: "relayed",
    status: "ASKED", fingerprint: fingerprintOf(evidence, ["a"]),
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

describe("parseAnswerFlags", () => {
  it("parses one pair", () => {
    const parsed = parseAnswerFlags(["d-0123456789abcdef0123=all"]);
    assert.ok("byDecision" in parsed);
    assert.deepEqual(parsed.byDecision.get("d-0123456789abcdef0123"), ["all"]);
  });

  it("accumulates repeated flags for multi-choice", () => {
    const parsed = parseAnswerFlags([
      "d-0123456789abcdef0123=all",
      "d-0123456789abcdef0123=backend",
    ]);
    assert.ok("byDecision" in parsed);
    assert.deepEqual(parsed.byDecision.get("d-0123456789abcdef0123"), ["all", "backend"]);
  });

  it("does not split on commas, which are legal inside free text", () => {
    const parsed = parseAnswerFlags(["d-0123456789abcdef0123=keycloak, then auth0"]);
    assert.ok("byDecision" in parsed);
    assert.deepEqual(parsed.byDecision.get("d-0123456789abcdef0123"), ["keycloak, then auth0"]);
  });

  it("rejects a malformed pair", () => {
    assert.ok("problems" in parseAnswerFlags(["nonsense"]));
  });

  it("rejects an id that is not a decision id", () => {
    assert.ok("problems" in parseAnswerFlags(["../escape=all"]));
  });
});

describe("validateAnswer", () => {
  it("accepts a known single choice", () => {
    const result = validateAnswer(decision("single-choice"), ["all"]);
    assert.ok("value" in result);
    assert.equal(result.value, "all");
  });

  it("rejects an unknown option", () => {
    assert.ok("problems" in validateAnswer(decision("single-choice"), ["invented"]));
  });

  it("rejects more than one value for single choice", () => {
    assert.ok("problems" in validateAnswer(decision("single-choice"), ["all", "backend"]));
  });

  it("accepts a subset for multi choice", () => {
    const result = validateAnswer(decision("multi-choice"), ["all", "backend"]);
    assert.ok("value" in result);
    assert.deepEqual(result.value, ["all", "backend"]);
  });

  it("rejects duplicates for multi choice", () => {
    assert.ok("problems" in validateAnswer(decision("multi-choice"), ["all", "all"]));
  });

  it("accepts booleans", () => {
    const result = validateAnswer(decision("boolean"), ["true"]);
    assert.ok("value" in result);
    assert.equal(result.value, true);
  });

  it("rejects non-boolean text for booleans", () => {
    assert.ok("problems" in validateAnswer(decision("boolean"), ["maybe"]));
  });

  it("enforces the free-text pattern and length", () => {
    const constrained = decision("free-text", { pattern: "^[a-z-]+$", max_length: 10 });
    assert.ok("value" in validateAnswer(constrained, ["keycloak"]));
    assert.ok("problems" in validateAnswer(constrained, ["Key Cloak!"]));
    assert.ok("problems" in validateAnswer(constrained, ["aaaaaaaaaaaaaaaaaaaa"]));
  });
});

describe("assertAnswerIdentity", () => {
  it("accepts a human identity", () => {
    assert.equal(assertAnswerIdentity("anderson@example.com"), "anderson@example.com");
  });

  it("rejects a missing identity — there is no fallback to git config", () => {
    assert.throws(() => assertAnswerIdentity(undefined), AnswerIdentityError);
  });

  it("rejects reserved non-human identities", () => {
    for (const reserved of ["agent", "paved", "ci"]) {
      assert.throws(() => assertAnswerIdentity(reserved), AnswerIdentityError);
    }
  });

  it("rejects whitespace-only identities", () => {
    assert.throws(() => assertAnswerIdentity("   "), AnswerIdentityError);
  });
});
