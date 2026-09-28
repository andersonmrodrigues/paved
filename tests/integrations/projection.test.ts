import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyProjection, planProjection, removeProjection } from "../../integrations/shared/projection.ts";
import { at } from "../helpers.ts";

describe("agent projections", () => {
  it("renders deterministic Codex and Claude projections from the same canonical skills", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    try {
      const codex = planProjection("codex", project, at("."));
      const claude = planProjection("claude-code", project, at("."));
      assert.deepEqual(
        codex.files.filter((file) => file.relativePath.endsWith("SKILL.md")).map((file) => file.relativePath.split("/").at(-2)),
        claude.files.filter((file) => file.relativePath.endsWith("SKILL.md")).map((file) => file.relativePath.split("/").at(-2)),
      );
      assert.equal(codex.files.some((file) => file.content.includes("paved verify --json")), true);
      assert.equal(claude.files.some((file) => file.relativePath === ".claude-plugin/plugin.json"), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("is idempotent and protects manually edited generated files", () => {
    const project = mkdtempSync(join(tmpdir(), "paved-integration-"));
    try {
      const plan = planProjection("codex", project, at("."));
      const first = applyProjection(plan);
      const second = applyProjection(plan);
      assert.equal(first.changed, plan.files.length);
      assert.equal(second.changed, 0);
      assert.equal(second.unchanged, plan.files.length);
      const target = join(plan.integration.root, plan.files[0]!.relativePath);
      writeFileSync(target, "human content\n");
      assert.throws(() => applyProjection(plan), /user-owned/);
      assert.equal(removeProjection(plan), plan.files.length - 1);
      assert.equal(readFileSync(target, "utf8"), "human content\n");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
