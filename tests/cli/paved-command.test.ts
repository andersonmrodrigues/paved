import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withPavedCommand } from "../../cli/lib/paved-command.ts";
import { createDiagnostic, createResult } from "../../cli/result.ts";

const result = () => createResult({
  command: "status",
  status: "warning",
  data: {
    nextAction: "Run paved update --json, then `paved status`.",
    remediation: { command: "paved update --json", reason: "Context drifted." },
    summary: "paved status reported nothing",
    note: "Commit .paved/paved.lock and keep paved plans small.",
  },
  diagnostics: [createDiagnostic({
    severity: "warning", category: "findings", code: "PAVED_X", component: "test",
    message: "Run paved verify later.", remediation: "Run paved verify --json.",
  })],
});

describe("pasteable Paved commands", () => {
  it("prints the project command in remediation and next-action texts", () => {
    const rewritten = withPavedCommand(result(), "'/repo dir/.paved/runtime/bin/paved'");
    const data = rewritten.data as Record<string, unknown>;
    assert.equal(data.nextAction, "Run '/repo dir/.paved/runtime/bin/paved' update --json, then `'/repo dir/.paved/runtime/bin/paved' status`.");
    assert.deepEqual(data.remediation, { command: "'/repo dir/.paved/runtime/bin/paved' update --json", reason: "Context drifted." });
    assert.equal(rewritten.diagnostics[0]?.remediation, "Run '/repo dir/.paved/runtime/bin/paved' verify --json.");
  });

  it("leaves other text, paths and prose alone", () => {
    const rewritten = withPavedCommand(result(), "/repo/.paved/runtime/bin/paved");
    const data = rewritten.data as Record<string, unknown>;
    assert.equal(data.summary, "paved status reported nothing");
    assert.equal(data.note, "Commit .paved/paved.lock and keep paved plans small.");
    assert.equal(rewritten.diagnostics[0]?.message, "Run paved verify later.");
  });

  it("keeps bare commands without a launcher-provided command", () => {
    for (const command of [undefined, "", "  ", "paved", "a\nb"]) assert.deepEqual(withPavedCommand(result(), command), result());
  });
});
