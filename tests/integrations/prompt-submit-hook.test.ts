import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const handler = join(root, "integrations/shared/prompt-submit-hook.mjs");
const temporary: string[] = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function fixture(initialized = true) {
  const dir = mkdtempSync(join(root, ".hook-test-"));
  temporary.push(dir);
  const cwd = join(dir, "project");
  const plugin = join(dir, "plugin");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "scripts"));
  if (initialized) {
    mkdirSync(join(cwd, ".paved", "runtime"), { recursive: true });
    writeFileSync(join(cwd, ".paved", "manifest.yaml"), "version: test\n");
    writeFileSync(join(cwd, ".paved", "paved.lock"), "version: test\n");
    writeFileSync(join(cwd, ".paved", "runtime", "selection.json"), "{}");
  }
  const hook = join(plugin, "hooks", "paved-prompt-submit.mjs");
  copyFileSync(handler, hook);
  writeFileSync(join(plugin, "scripts", "paved.mjs"), `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + "\\n");
process.stdout.write(args[0] === "auto-update"
  ? JSON.stringify({ command: "auto-update", status: "success", data: { reason: "disabled" } })
  : process.env.TEST_RESULT);
process.exit(Number(process.env.TEST_EXIT || 0));
`);
  return { cwd, hook, log: join(dir, "calls") };
}

function run(f: ReturnType<typeof fixture>, event: object, result: object, host = "claude-code", exit = 0) {
  return spawnSync(process.execPath, [f.hook, "--host", host], {
    input: JSON.stringify({ cwd: f.cwd, ...event }), encoding: "utf8", timeout: 5000,
    env: { ...process.env, TEST_LOG: f.log, TEST_RESULT: JSON.stringify(result), TEST_EXIT: String(exit) },
  });
}

describe("lean lifecycle hooks", () => {
  it("injects a bounded index after checking configured updates without initializing", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "SessionStart", source: "startup" },
      { command: "doctor", status: "warning", data: { status: "stale-context", staleGenerators: ["api"] } });
    assert.equal(result.status, 0, result.stderr);
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(text, /stale-context/);
    assert.match(text, /paved context/);
    assert.ok(text.length <= 1200);
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ["auto-update", "check", "--host", "claude-code", "--json", "--project", f.cwd],
      ["doctor", "--quick", "--json", "--project", f.cwd],
    ]);
  });

  it("does not run a launcher for an uninitialized repository", () => {
    const f = fixture(false);
    const result = run(f, { hook_event_name: "SessionStart", source: "startup" }, {});
    assert.equal(result.status, 0);
    assert.match(result.stdout, /uninitialized/);
    assert.throws(() => readFileSync(f.log, "utf8"));
  });

  it("reports incomplete state as broken without bootstrapping", () => {
    const f = fixture(false);
    mkdirSync(join(f.cwd, ".paved"));
    const result = run(f, { hook_event_name: "SessionStart", source: "resume" }, {});
    assert.match(result.stdout, /broken/);
    assert.throws(() => readFileSync(f.log, "utf8"));
  });

  it("lists open tasks without selecting one for verification", () => {
    const f = fixture();
    mkdirSync(join(f.cwd, ".paved", "tasks"));
    writeFileSync(join(f.cwd, ".paved", "tasks", "first.md"), "## State\nStatus: open\n");
    writeFileSync(join(f.cwd, ".paved", "tasks", "second.md"), "## State\nStatus: open\n");
    writeFileSync(join(f.cwd, ".paved", "tasks", "done.md"), "## State\nStatus: done\n");
    const start = run(f, { hook_event_name: "SessionStart", source: "resume" }, { data: { status: "healthy" } });
    assert.match(start.stdout, /first.md.*second.md/);
    assert.doesNotMatch(start.stdout, /done.md/);
    run(f, { hook_event_name: "Stop" }, { command: "verify", status: "failed" }, "codex", 7);
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /--task/);
  });

  it("blocks Stop on failed verification for Claude and Codex", () => {
    for (const host of ["claude-code", "codex"]) {
      const f = fixture();
      const result = run(f, { hook_event_name: "Stop", stop_hook_active: false },
        { command: "verify", status: "failed", diagnostics: [{ message: "tests failed" }] }, host, 7);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, "block");
      assert.match(JSON.parse(result.stdout).reason, /verify --changed/);
      assert.match(readFileSync(f.log, "utf8"), /"verify","--changed"/);
    }
  });

  it("does not block a verified Stop, or loop on a continued Stop", () => {
    const f = fixture();
    const green = run(f, { hook_event_name: "Stop", stop_hook_active: false },
      { command: "verify", status: "success", data: { completion: { status: "complete", verification: "verified" } } });
    assert.notEqual(green.stdout && JSON.parse(green.stdout).decision, "block");
    const retried = run(f, { hook_event_name: "Stop", stop_hook_active: true },
      { command: "verify", status: "failed" }, "claude-code", 7);
    assert.notEqual(retried.stdout && JSON.parse(retried.stdout).decision, "block");
    assert.match(retried.stdout, /NOT VERIFIED/);
  });

  it("reports an unavailable verification and never invents support for another host", () => {
    const f = fixture();
    rmSync(join(f.cwd, ".paved", "runtime", "selection.json"));
    const blocked = run(f, { hook_event_name: "Stop", stop_hook_active: false }, {}, "codex");
    assert.equal(JSON.parse(blocked.stdout).decision, "block");
    assert.throws(() => readFileSync(f.log, "utf8"));
    assert.equal(run(f, { hook_event_name: "Stop" }, {}, "cursor").stdout, "");
  });

  it("does not accept a successful-looking result from a failed launcher", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "Stop" },
      { command: "verify", status: "success", data: { completion: { status: "complete", verification: "verified" } } },
      "claude-code", 7);
    assert.equal(JSON.parse(result.stdout).decision, "block");
  });

  it("removes per-prompt routing and ignores malformed input", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "UserPromptSubmit", prompt: "private" }, {});
    assert.equal(result.stdout, "");
    const malformed = spawnSync(process.execPath, [f.hook], { input: "bad", encoding: "utf8" });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, "");
  });
});
