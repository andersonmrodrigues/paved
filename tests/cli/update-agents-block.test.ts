import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { agentsBlockState, refreshAgentsBlock } from "../../cli/lib/agents-block.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const template = readFileSync(join(core, "core/templates/AGENTS.md"), "utf8").trimEnd();
const legacy = template.replace("`/paved:intent`", "`/paved:feature`");
let project = "";
beforeEach(() => { project = mkdtempSync(join(tmpdir(), "paved-agents-")); });
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("refreshAgentsBlock", () => {
  it("rewrites an outdated block and keeps the text around it byte-identical", () => {
    const before = "# Team notes\n\nKeep tabs.\t\n\n";
    const after = "\n\n## Our rules\n- one\n";
    writeFileSync(join(project, "AGENTS.md"), `${before}${legacy}${after}`);
    assert.equal(agentsBlockState(core, project), "outdated");
    assert.equal(refreshAgentsBlock(core, project).status, "updated");
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), `${before}${template}${after}`);
    assert.equal(agentsBlockState(core, project), "current");
  });

  it("never creates a block or a file", () => {
    assert.equal(refreshAgentsBlock(core, project).status, "unchanged");
    assert.equal(existsSync(join(project, "AGENTS.md")), false);
    writeFileSync(join(project, "AGENTS.md"), "# Only ours\n");
    assert.equal(refreshAgentsBlock(core, project).status, "unchanged");
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "# Only ours\n");
  });

  it("reports a block without an end marker", () => {
    writeFileSync(join(project, "AGENTS.md"), "<!-- paved:begin managed -->\nbroken\n");
    assert.equal(refreshAgentsBlock(core, project).status, "invalid");
  });
});
