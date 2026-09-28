import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDiagnostic, createResult, exitCode, type DecisionProjection } from "../../cli/result.ts";
import { renderHuman } from "../../cli/output.ts";

const projection: DecisionProjection = {
  id: "d-0123456789abcdef0123",
  question: "Should the detected checks become verification gates?",
  reason: "They already run in CI but are not authorized as Paved gates.",
  options: [{ id: "all", label: "All", description: "Adopt every check.", consequence: "All become gates." }],
  evidence: [{ type: "file", location: "pom.xml", sha256: "a".repeat(64) }],
  required: true,
  risk: "low",
  reversibility: "reversible",
  answerChannel: "relayed",
};

describe("awaiting_input result contract", () => {
  it("exits with the dedicated awaiting-input code", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [projection] });
    assert.equal(result.status, "awaiting_input");
    assert.equal(exitCode(result), 10);
  });

  it("exposes decisions at the top level, not inside data", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [projection] });
    assert.equal(result.decisions?.length, 1);
    assert.equal(result.data, undefined);
  });

  it("refuses awaiting_input without a required decision", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [] });
    assert.equal(result.status, "failed");
    assert.ok(result.diagnostics.some((item) => item.code === "PAVED_RESULT_MALFORMED_AWAITING_INPUT"));
  });

  it("refuses awaiting_input alongside a blocking diagnostic", () => {
    // Paved must not ask a question it cannot act on regardless of the answer.
    const result = createResult({
      command: "verify",
      status: "awaiting_input",
      decisions: [projection],
      diagnostics: [createDiagnostic({
        severity: "error", category: "config", code: "PAVED_X",
        component: "test", message: "blocked",
      })],
    });
    assert.equal(result.status, "failed");
  });

  it("allows awaiting_input alongside non-blocking findings", () => {
    const result = createResult({
      command: "verify",
      status: "awaiting_input",
      decisions: [projection],
      diagnostics: [createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_Y",
        component: "test", message: "advisory",
      })],
    });
    assert.equal(result.status, "awaiting_input");
    assert.equal(exitCode(result), 10);
  });

  it("allows optional decisions to ride along with a success result", () => {
    const optional = { ...projection, required: false };
    const result = createResult({ command: "doctor", status: "success", decisions: [optional] });
    assert.equal(result.status, "success");
    assert.equal(exitCode(result), 0);
    assert.equal(result.decisions?.length, 1);
  });

  it("keeps existing statuses and exit codes unchanged", () => {
    assert.equal(exitCode(createResult({ command: "status", status: "success" })), 0);
    const failed = createResult({
      command: "status", status: "failed",
      diagnostics: [createDiagnostic({
        severity: "error", category: "config", code: "PAVED_Z", component: "t", message: "m",
      })],
    });
    assert.equal(exitCode(failed), 4);
  });
});

describe("human rendering of decisions", () => {
  it("renders the question, reason, numbered options and resume command", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [projection] });
    const text = renderHuman(result);
    assert.match(text, /d-0123456789abcdef0123/);
    assert.match(text, /Should the detected checks become verification gates\?/);
    assert.match(text, /already run in CI/);
    assert.match(text, /1\. all/);
    assert.match(text, /--answer d-0123456789abcdef0123=/);
    assert.match(text, /--answered-by/);
  });

  it("marks the recommendation and shows its evidence", () => {
    const recommended = { ...projection, recommended: "all" };
    const text = renderHuman(createResult({
      command: "verify", status: "awaiting_input", decisions: [recommended],
    }));
    assert.match(text, /recommended/i);
    assert.match(text, /pom\.xml/);
  });

  it("marks human-authored decisions as needing an approval file", () => {
    const approval = { ...projection, answerChannel: "human-authored" as const };
    const text = renderHuman(createResult({
      command: "doctor", status: "awaiting_input", decisions: [approval],
    }));
    assert.match(text, /\.paved\/approvals\/d-0123456789abcdef0123\.json/);
  });

  it("labels optional decisions so they do not read as blocking", () => {
    const optional = { ...projection, required: false };
    const text = renderHuman(createResult({ command: "doctor", status: "success", decisions: [optional] }));
    assert.match(text, /optional/i);
  });
});
