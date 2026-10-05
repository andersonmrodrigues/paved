import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function runHook(input: string, state = repository("state")): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [handler], { input, encoding: "utf8", timeout: 5_000, env: { ...process.env, TMPDIR: state } });
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
    assert.match(output.hookSpecificOutput.additionalContext, /paved:task-specification/);
    assert.match(output.hookSpecificOutput.additionalContext, /paved:task-review/);
    assert.ok(output.hookSpecificOutput.additionalContext.includes("Paved `intent` command"));
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

  it("preserves UTF-8 paths when stdin splits a multibyte character", async () => {
    const root = repository("utf8");
    const cwd = join(root, "projeto-ação");
    mkdirSync(cwd);
    initialize(cwd);
    const payload = Buffer.from(JSON.stringify({ cwd }));
    const character = Buffer.from("ç");
    const split = payload.indexOf(character) + 1;
    assert.ok(split > 0);

    const child = spawn(process.execPath, [handler], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.stdin.write(payload.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.stdin.end(payload.subarray(split));

    assert.equal(await closed, 0, stderr);
    assert.match(stdout, /hookSpecificOutput/);
    assert.equal(stderr, "");
  });

  it("adds the guidance once per session and repository", () => {
    const cwd = repository("once");
    initialize(cwd);
    const state = repository("once-state");
    const prompt = (session: string) => runHook(JSON.stringify({ cwd, session_id: session, hook_event_name: "UserPromptSubmit" }), state);

    assert.match(prompt("s-1").stdout, /hookSpecificOutput/);
    assert.equal(prompt("s-1").stdout, "");
    assert.match(prompt("s-2").stdout, /hookSpecificOutput/);
  });

  it("adds the guidance again after compaction or clear in the same session", () => {
    const cwd = repository("compact");
    initialize(cwd);
    const state = repository("compact-state");
    runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit" }), state);

    for (const source of ["compact", "clear"]) {
      const started = runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "SessionStart", source }), state);
      const output = JSON.parse(started.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
      assert.ok(output.hookSpecificOutput.additionalContext.includes("Paved `intent` command"));
    }
    assert.equal(runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit" }), state).stdout, "");
  });

  it("ignores a session start that is not a compaction or clear", () => {
    const cwd = repository("startup");
    initialize(cwd);
    for (const source of ["startup", "resume", undefined]) {
      assert.equal(runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "SessionStart", source })).stdout, "", String(source));
    }
  });

  it("still adds the guidance when the session state cannot be recorded", () => {
    const cwd = repository("unwritable");
    initialize(cwd);
    const blocked = join(repository("unwritable-state"), "file");
    writeFileSync(blocked, "not a directory\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.match(runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit" }), blocked).stdout, /hookSpecificOutput/);
    }
  });
});
