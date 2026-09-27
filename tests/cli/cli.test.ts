import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDiagnostic,
  createResult,
  type DiagnosticCategory,
  exitCode,
  primaryCategory,
} from "../../cli/result.ts";
import { renderHuman, renderJson } from "../../cli/output.ts";

function result(...categories: DiagnosticCategory[]) {
  return createResult({
    command: "synthetic",
    status: categories.length === 0 ? "success" : "failed",
    diagnostics: categories.map((category, index) => createDiagnostic({
      category,
      severity: category === "findings" ? "warning" : "error",
      code: `PAVED_${index}`,
      component: "cli.test",
      message: `Diagnostic ${index} for ${category}`,
      remediation: `Fix ${category}`,
    })),
  });
}

describe("CLI result exit behavior", () => {
  it("maps each result category to a stable exit code", () => {
    assert.equal(exitCode(createResult({ command: "synthetic", status: "success" })), 0);
    assert.equal(exitCode(result("findings")), 1);
    assert.equal(exitCode(result("usage")), 2);
    assert.equal(exitCode(result("environment")), 3);
    assert.equal(exitCode(result("config")), 4);
    assert.equal(exitCode(result("resolution")), 5);
    assert.equal(exitCode(result("generation/update")), 6);
    assert.equal(exitCode(result("verification")), 7);
    assert.equal(exitCode(result("conflict")), 8);
    assert.equal(exitCode(result("internal")), 9);
  });

  it("selects the deterministic primary category regardless of diagnostic order", () => {
    const first = result("usage", "verification", "config");
    const second = result("config", "usage", "verification");

    assert.equal(primaryCategory(first), "verification");
    assert.equal(primaryCategory(second), "verification");
    assert.equal(exitCode(first), 7);
    assert.equal(exitCode(second), 7);
  });

  it("maps warning status without diagnostics to findings exit code", () => {
    assert.equal(exitCode(createResult({ command: "synthetic", status: "warning" })), 1);
  });

  it("gives internal diagnostics precedence over other blocking categories", () => {
    const mixed = result("conflict", "internal", "verification");

    assert.equal(primaryCategory(mixed), "internal");
    assert.equal(exitCode(mixed), 9);
  });

  it("retains all diagnostics while selecting the primary failure", () => {
    const diagnostics = result("usage", "findings", "conflict").diagnostics;

    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.category), ["usage", "findings", "conflict"]);
    assert.equal(diagnostics.length, 3);
  });
});

describe("CLI result renderers", () => {
  it("renders human and JSON output from the same structured result", () => {
    const structured = createResult({
      command: "doctor",
      status: "failed",
      data: { checked: 2 },
      diagnostics: [
        createDiagnostic({
          category: "config",
          severity: "error",
          code: "PAVED_CONFIG_INVALID",
          component: "manifest",
          message: "Manifest is invalid",
          remediation: "Fix .paved/manifest.yaml",
        }),
        createDiagnostic({
          category: "findings",
          severity: "warning",
          code: "PAVED_WARNING",
          component: "verification",
          message: "Verification profile is missing",
        }),
      ],
    });

    const json = JSON.parse(renderJson(structured)) as typeof structured;
    const human = renderHuman(structured);

    assert.deepEqual(json, structured);
    for (const diagnostic of structured.diagnostics) {
      assert.match(human, new RegExp(diagnostic.code));
      assert.match(human, new RegExp(diagnostic.message));
      assert.match(human, new RegExp(diagnostic.component));
    }
    assert.doesNotMatch(human, /stack/i);
    assert.doesNotMatch(renderJson(structured), /stack/i);
  });
});
