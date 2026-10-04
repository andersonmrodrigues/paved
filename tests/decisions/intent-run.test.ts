import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { loadYaml } from "../../cli/lib/documents.ts";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { writeRun, type Run } from "../../cli/lib/workflow-runs.ts";
import { dispatchCli } from "../../cli/runtime.ts";

const coreRoot = join(import.meta.dirname, "..", "..");
const fixture = loadYaml(join(coreRoot, "tests/fixtures/schemas/workflow-run/valid/pending-classification.yaml")) as Run;

describe("agent decisions on intent runs", () => {
  it("records a decision against a pending intent run", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-intent-decision-"));
    try {
      writeFileSync(join(projectRoot, "README.md"), "# Consumer\n");
      initializeConsumer(coreRoot, projectRoot, "consumer");
      writeRun(projectRoot, coreRoot, fixture);
      const readme = readFileSync(join(projectRoot, "README.md"));
      const result = await dispatchCli({ cwd: projectRoot, executablePath: join(coreRoot, "cli/index.ts"), argv: ["decision", "raise", "--project", projectRoot, "--json", "--decision", JSON.stringify({
        run: fixture.id, question: "Which export format?", reason: "The request does not say.",
        options: [
          { id: "csv", label: "CSV", description: "Comma separated.", consequence: "Spreadsheet friendly." },
          { id: "json", label: "JSON", description: "Structured.", consequence: "Program friendly." },
        ],
        evidence: [{ type: "file", location: "README.md", sha256: createHash("sha256").update(readme).digest("hex") }],
        required: true, requiredAnswer: { type: "single-choice" },
      })] });
      assert.equal(result.status, "success", JSON.stringify(result.diagnostics));
      const stored = parse(readFileSync(join(projectRoot, `.paved/generated/runs/${fixture.id}.yaml`), "utf8")) as Run;
      assert.equal(stored.decisions?.at(-1)?.command, "intent");
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
