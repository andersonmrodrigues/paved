import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  it("adds the full routing guidance when a session starts", () => {
    const cwd = repository("initialized");
    initialize(cwd);

    const result = runHook(JSON.stringify({ cwd, hook_event_name: "SessionStart", source: "startup" }));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /unrelated/i);
    assert.match(context, /paved:task-specification/);
    assert.match(context, /paved:task-review/);
    assert.ok(context.includes("Paved `intent` command"));
    assert.match(context, /`routing`.*subagent.*capacity and reasoning effort/);
    assert.match(context, /without an explicit Paved command/);
    assert.match(context, /resume the matching run.*do not create a duplicate/);
    assert.match(context, /planning-only.*stop.*plan/);
    assert.match(context, /investigation-only.*do not implement a fix/);
  });

  it("keeps the per-prompt reminder to one short line without echoing the prompt", () => {
    const cwd = repository("reminder");
    initialize(cwd);
    const result = runHook(JSON.stringify({ cwd, prompt: "private user prompt" }));
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const reminder = output.hookSpecificOutput.additionalContext;
    assert.ok(!reminder.includes("\n") && reminder.length < 400, reminder);
    assert.match(reminder, /intent, plan and execute/);
    assert.match(reminder, /explicit human approval/);
    assert.match(reminder, /`routing`/);
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

  it("routes natural-language requests on every prompt without writing session state", () => {
    const cwd = repository("every-prompt");
    initialize(cwd);
    const state = repository("stateless");
    const requests = [
      "Explique a estrutura do projeto",
      "Implemente a nova funcionalidade",
      "Planeje a alteração, sem implementar",
      "Investigue o erro, sem corrigir ainda",
      "Continue o desenvolvimento",
    ];

    for (const prompt of requests) {
      const result = runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit", prompt }), state);
      assert.equal(result.status, 0, result.stderr);
      const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
      assert.match(context, /development, planning, fixes, debugging and refactoring/);
      assert.match(context, /resume the matching run/);
      assert.match(context, /explicit human approval/);
      assert.doesNotMatch(result.stdout, new RegExp(prompt));
    }
    assert.deepEqual(readdirSync(state), [], "routing does not persist session markers or prompts");
  });

  it("adds the full guidance at every session start, including after compaction or clear", () => {
    const cwd = repository("compact");
    initialize(cwd);
    const state = repository("compact-state");
    runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit" }), state);

    for (const source of ["startup", "resume", "compact", "clear"]) {
      const started = runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "SessionStart", source }), state);
      const output = JSON.parse(started.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
      assert.ok(output.hookSpecificOutput.additionalContext.includes("Paved `intent` command"));
    }
    assert.match(runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit" }), state).stdout, /hookSpecificOutput/);
  });

  it("ignores a session start from an unknown source", () => {
    const cwd = repository("startup");
    initialize(cwd);
    for (const source of ["other", undefined]) {
      assert.equal(runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "SessionStart", source })).stdout, "", String(source));
    }
  });

  it("does not depend on a writable temporary directory", () => {
    const cwd = repository("unwritable");
    initialize(cwd);
    const blocked = join(repository("unwritable-state"), "file");
    writeFileSync(blocked, "not a directory\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.match(runHook(JSON.stringify({ cwd, session_id: "s-1", hook_event_name: "UserPromptSubmit" }), blocked).stdout, /hookSpecificOutput/);
    }
  });
});
