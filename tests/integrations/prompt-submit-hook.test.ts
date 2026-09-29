import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const handler = join(root, "integrations/shared/prompt-submit-hook.mjs");
const temporary: string[] = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function repository(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `paved-hook-${name}-`));
  temporary.push(path);
  return path;
}

function initialize(path: string): void {
  mkdirSync(join(path, ".paved"), { recursive: true });
  writeFileSync(join(path, ".paved", "manifest.yaml"), "version: test\n");
  writeFileSync(join(path, ".paved", "paved.lock"), "version: test\n");
}

function runHook(input: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [handler], { input, encoding: "utf8", timeout: 5_000 });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("prompt submit hook", () => {
  it("adds only routing guidance for an initialized Paved repository", () => {
    const cwd = repository("initialized");
    initialize(cwd);

    const result = runHook(JSON.stringify({ cwd, prompt: "private user prompt" }));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /Paved/i);
    assert.match(output.hookSpecificOutput.additionalContext, /unrelated/i);
    assert.doesNotMatch(result.stdout, /private user prompt/);
  });

  it("finds the nearest initialized repository from a nested directory", () => {
    const cwd = repository("nested");
    initialize(cwd);
    const nested = join(cwd, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    const result = runHook(JSON.stringify({ cwd: nested }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hookSpecificOutput/);
  });

  it("stops at the nearest nested Git boundary before finding a parent Paved state", () => {
    const parent = repository("boundary");
    initialize(parent);
    const nested = join(parent, "nested");
    mkdirSync(join(nested, ".git"), { recursive: true });

    const result = runHook(JSON.stringify({ cwd: nested }));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("recognizes a worktree-style .git file as a repository boundary", () => {
    const parent = repository("git-file");
    initialize(parent);
    const nested = join(parent, "worktree");
    mkdirSync(nested);
    writeFileSync(join(nested, ".git"), "gitdir: ../.git/worktrees/child\n");

    const result = runHook(JSON.stringify({ cwd: nested }));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("does not inject for unrelated repositories or incomplete Paved state", () => {
    const unrelated = repository("unrelated");
    const manifestOnly = repository("manifest-only");
    mkdirSync(join(manifestOnly, ".paved"));
    writeFileSync(join(manifestOnly, ".paved", "manifest.yaml"), "version: test\n");
    const lockOnly = repository("lock-only");
    mkdirSync(join(lockOnly, ".paved"));
    writeFileSync(join(lockOnly, ".paved", "paved.lock"), "version: test\n");

    for (const cwd of [unrelated, manifestOnly, lockOnly]) {
      const result = runHook(JSON.stringify({ cwd }));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "", cwd);
      assert.equal(result.stderr, "", cwd);
    }
  });

  it("fails open without output for malformed and incomplete input", () => {
    for (const input of ["not json", "null", "[]", "{}", JSON.stringify({ cwd: 4 })]) {
      const result = runHook(input);
      assert.equal(result.status, 0, input);
      assert.equal(result.stdout, "", input);
      assert.equal(result.stderr, "", input);
    }
  });
});
