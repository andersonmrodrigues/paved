import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { loadYaml } from "../../cli/lib/documents.ts";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { writeRun, type Run } from "../../cli/lib/workflow-runs.ts";
import { dispatchCli } from "../../cli/runtime.ts";

const coreRoot = join(import.meta.dirname, "..", "..");
const pending = loadYaml(join(coreRoot, "tests/fixtures/schemas/workflow-run/valid/pending-classification.yaml")) as Run;

function consumer(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), "paved-status-"));
  writeFileSync(join(projectRoot, "README.md"), "# Consumer\n");
  initializeConsumer(coreRoot, projectRoot, "consumer");
  return projectRoot;
}

describe("status open runs", () => {
  it("lists open runs and points at status, not doctor", async () => {
    const projectRoot = consumer();
    try {
      writeRun(projectRoot, coreRoot, pending);
      const status = await dispatchCli({ argv: ["status", "--project", projectRoot, "--json"] });
      const data = status.data as { openRuns?: { run: string; status: string }[]; nextAction: string };
      assert.deepEqual(data.openRuns?.map((item) => item.run), [pending.id]);
      assert.doesNotMatch(JSON.stringify(status), /paved doctor/);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});

describe("status verification setup", () => {
  it("reports a Check whose Tool exists nowhere before execute reaches verification", async () => {
    const projectRoot = consumer();
    try {
      mkdirSync(join(projectRoot, ".paved/verification/checks"), { recursive: true });
      writeFileSync(join(projectRoot, ".paved/verification/checks/unit.yaml"), stringify({
        apiVersion: "paved/v1", kind: "Check", id: "project.testing.unit", title: "Tests pass", purpose: "The suite passes.",
        type: "unit", tool: "project.missing.tool", expected: { description: "Exit 0.", exit_code: 0 }, timeout_seconds: 30,
        environment: { kinds: ["local"] }, failure: "A test failed.", determinism: { class: "deterministic" }, retry: { class: "non-retryable" },
      }));
      writeFileSync(join(projectRoot, ".paved/verification/profile.yaml"), stringify({
        apiVersion: "paved/v1", kind: "VerificationProfile", checks: ["project.testing.unit"],
      }));
      const status = await dispatchCli({ argv: ["status", "--project", projectRoot, "--json"] });
      const codes = (status.data as { actionableFindings: { code: string }[] }).actionableFindings.map((item) => item.code);
      assert.ok(codes.includes("PAVED_VERIFY_TOOL_UNRESOLVED"), codes.join(", "));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
