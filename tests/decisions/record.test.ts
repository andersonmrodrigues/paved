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
});
