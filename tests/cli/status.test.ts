import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { agentsBlockState, ensureAgentsBlock, refreshAgentsBlock } from "../../cli/lib/agents-block.ts";
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

describe("status", () => {
  it("reports an outdated managed AGENTS.md block, and refresh rewrites only the block", async () => {
    const projectRoot = consumer();
    try {
      ensureAgentsBlock(coreRoot, projectRoot);
      const path = join(projectRoot, "AGENTS.md");
      writeFileSync(path, `# Mine\n\n${readFileSync(path, "utf8").replace("/paved:intent", "/paved:feature")}`);
      assert.equal(agentsBlockState(coreRoot, projectRoot), "outdated");
      const status = await dispatchCli({ argv: ["status", "--project", projectRoot, "--json"] });
      assert.ok(status.diagnostics.some((item) => item.code === "PAVED_AGENTS_BLOCK_OUTDATED"), JSON.stringify(status.diagnostics));
      assert.equal(refreshAgentsBlock(coreRoot, projectRoot).status, "updated");
      assert.equal(agentsBlockState(coreRoot, projectRoot), "current");
      assert.ok(readFileSync(path, "utf8").startsWith("# Mine\n"));
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it("never creates a block that is absent", () => {
    const projectRoot = consumer();
    try {
      rmSync(join(projectRoot, "AGENTS.md"), { force: true });
      assert.equal(refreshAgentsBlock(coreRoot, projectRoot).status, "unchanged");
      assert.equal(agentsBlockState(coreRoot, projectRoot), "absent");
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

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
