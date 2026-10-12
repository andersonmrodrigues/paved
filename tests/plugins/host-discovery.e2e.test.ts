import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { codexVisibleSkills, expectedSkills, hostAvailable, installWithCodex, repositorySnapshot, workspace } from "./support.ts";

let root = "";
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("Codex host discovery", { skip: hostAvailable("codex") ? false : "codex CLI is not installed" }, () => {
  it("installs the plugin and exposes every skill to the model", () => {
    root = workspace("codex-discovery");
    const installed = installWithCodex(repositorySnapshot(root), join(root, "codex-home"));
    assert.ok(installed.includes(join("plugins", "cache", "paved", "paved")), installed);
    const project = join(root, "project");
    mkdirSync(project);
    const visible = codexVisibleSkills(join(root, "codex-home"), project);
    assert.deepEqual(visible, expectedSkills().map((name) => `paved:${name}`));
  });
});
