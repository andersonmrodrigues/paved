import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + "\\n");
if (process.env.TEST_ESCAPE) {
  // A process outside the launcher's group that inherited its stdout keeps the pipe open after the group is gone.
  const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true });
  writeFileSync(process.env.TEST_ESCAPE, String(stray.pid));
  stray.unref();
  process.exit(0);
} else if (process.env.TEST_HANG) {
  // Stands in for the runtime the real launcher waits on: it must not outlive a timed-out hook.
  const runtime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.TEST_HANG, String(runtime.pid));
  setInterval(() => {}, 1000);
} else {
process.stdout.write(args[0] === "auto-update"
  ? JSON.stringify({ command: "auto-update", status: "success", data: { reason: "disabled" } })
  : process.env.TEST_RESULT);
process.exit(Number(process.env.TEST_EXIT || 0));
}
`);
  return { cwd, hook, log: join(dir, "calls") };
}

function run(f: ReturnType<typeof fixture>, event: object, result: object, host = "claude-code", exit = 0, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [f.hook, "--host", host], {
    input: JSON.stringify({ cwd: f.cwd, ...event }), encoding: "utf8", timeout: 10000,
    env: { ...process.env, TEST_LOG: f.log, TEST_RESULT: JSON.stringify(result), TEST_EXIT: String(exit), ...env },
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  it("asks once per session before the first code change in an uninitialized repository", () => {
    const f = fixture(false);
    const result = run(f, { hook_event_name: "SessionStart", source: "startup" }, {});
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(text, /ask the user once whether to use Paved/);
    assert.match(text, /run the Paved execute command with the request/);
    assert.match(text, /do not ask again this session/);
    assert.match(text, /Never initialize or repair without the user's yes/);
    assert.doesNotMatch(text, /Open tasks/);
    assert.ok(text.length <= 1200);
  });

  it("reports incomplete state as broken without bootstrapping", () => {
    const f = fixture(false);
    mkdirSync(join(f.cwd, ".paved"));
    const result = run(f, { hook_event_name: "SessionStart", source: "resume" }, {});
    assert.match(result.stdout, /broken/);
    assert.throws(() => readFileSync(f.log, "utf8"));
  });

  it("asks once per session to repair a broken repository through execute", () => {
    const f = fixture(false);
    mkdirSync(join(f.cwd, ".paved"));
    const result = run(f, { hook_event_name: "SessionStart", source: "startup" }, {});
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(text, /ask the user once whether to repair Paved and use it/);
    assert.match(text, /run the Paved execute command with the request/);
    assert.match(text, /do not ask again this session/);
    assert.doesNotMatch(text, /Work directly;/);
    assert.ok(text.length <= 1200);
  });

  it("routes code changes through execute in an initialized repository", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "SessionStart", source: "startup" }, { data: { status: "healthy" } });
    const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(text, /Route code changes .* through the Paved execute command/);
    assert.match(text, /Explicit user direction wins/);
    assert.doesNotMatch(text, /Work directly/);
    assert.ok(text.length <= 1200);
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

  it("stops the whole launcher process group when verification exceeds the Stop budget", { skip: process.platform === "win32" }, async () => {
    const f = fixture();
    const pidFile = join(dirname(f.log), "runtime.pid");
    const result = run(f, { hook_event_name: "Stop", stop_hook_active: false }, {}, "claude-code", 0,
      { TEST_HANG: pidFile, PAVED_HOOK_VERIFY_TIMEOUT_MS: "500" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /could not read the recorded verification within the 1 s Stop hook budget/);
    const runtime = Number(readFileSync(pidFile, "utf8"));
    for (let attempt = 0; attempt < 50 && alive(runtime); attempt += 1) await new Promise((done) => setTimeout(done, 100));
    assert.equal(alive(runtime), false, "the runtime child must not outlive the hook");
  });

  it("settles at its budget even when a process outside the group keeps the pipe open", { skip: process.platform === "win32" }, async () => {
    const f = fixture();
    const pidFile = join(dirname(f.log), "stray.pid");
    const started = Date.now();
    try {
      const result = run(f, { hook_event_name: "Stop", stop_hook_active: false }, {}, "claude-code", 0,
        { TEST_ESCAPE: pidFile, PAVED_HOOK_VERIFY_TIMEOUT_MS: "300" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Date.now() - started < 8000, "the hook must not wait for the stray pipe holder");
      assert.match(JSON.parse(result.stdout).reason, /Stop hook budget/);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("exits when the host never closes stdin", async () => {
    const f = fixture();
    const child = spawn(process.execPath, [f.hook, "--host", "claude-code"], { stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.write(JSON.stringify({ cwd: f.cwd, hook_event_name: "Stop" }));
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const code = await new Promise<number | null>((done) => {
      const kill = setTimeout(() => { child.kill("SIGKILL"); done(null); }, 15000);
      child.on("exit", (exitCode) => { clearTimeout(kill); done(exitCode); });
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });

  it("asks the agent to verify when nothing is recorded for the change", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "Stop", stop_hook_active: false },
      { command: "verify", status: "failed", diagnostics: [{ code: "PAVED_VERIFY_NOT_RECORDED", message: "none" }] }, "claude-code", 7);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /no verification is recorded for the current changes\. Run `paved verify --changed( --base \S+)?`/);
  });

  it("notes an older pinned runtime that rejects the hook's flags without blocking", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "Stop", stop_hook_active: false },
      { command: "verify", status: "failed", diagnostics: [{ code: "PAVED_CLI_USAGE", message: "Unknown flag: --changed." }] }, "claude-code", 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage, /paved update/);
    assert.doesNotMatch(output.systemMessage, /NOT VERIFIED/);
  });

  it("says when another Paved operation holds the lock", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "Stop", stop_hook_active: false },
      { command: "verify", status: "failed", diagnostics: [{ code: "PAVED_OPERATION_IN_PROGRESS", message: "locked" }] }, "claude-code", 8);
    assert.equal(JSON.parse(result.stdout).decision, "block");
    assert.match(JSON.parse(result.stdout).reason, /another Paved operation holds the project lock/);
  });

  it("only reads the recorded verification, compared with the merge base of the default branch", () => {
    const f = fixture();
    rmSync(join(f.cwd, ".git"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", f.cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "master");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("checkout", "-qb", "feature");
    const verified = { command: "verify", status: "success", data: { completion: { status: "complete", verification: "verified" } } };
    const verifyCall = () => readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]).at(-1);

    run(f, { hook_event_name: "Stop" }, verified, "claude-code", 0, { PAVED_HOOK_VERIFY_TIMEOUT_MS: "20000" });
    assert.deepEqual(verifyCall(), ["verify", "--changed", "--base", "master", "--recorded", "--json", "--project", f.cwd]);

    git("update-ref", "refs/remotes/origin/trunk", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    run(f, { hook_event_name: "Stop" }, verified);
    assert.deepEqual(verifyCall()?.slice(0, 5), ["verify", "--changed", "--base", "origin/trunk", "--recorded"]);
  });

  it("verifies only the working tree when no default branch is known", () => {
    const f = fixture();
    run(f, { hook_event_name: "Stop" }, { command: "verify", status: "success", data: { completion: { status: "complete", verification: "verified" } } },
      "claude-code", 0, { GIT_CEILING_DIRECTORIES: dirname(f.cwd) });
    assert.doesNotMatch(readFileSync(f.log, "utf8"), /--base/);
  });

  it("names each failing check with its output and a bounded excerpt", () => {
    const f = fixture();
    const checks = Array.from({ length: 9 }, (_, index) => ({
      id: `project.verify.check-${index}`, status: index === 1 ? "blocked" : "failed", type: "unit",
      output_ref: `.paved/generated/evidence/check-${index}.log`,
      ...(index === 1 ? { reason: "Not run on stale inputs: project.verify.check-0 is failed." } : {}),
      excerpt: Array.from({ length: 6 }, (_, line) => `FAIL spec ${index}.${line} ${"x".repeat(60)}`),
    }));
    const result = run(f, { hook_event_name: "Stop", stop_hook_active: false },
      { command: "verify", status: "failed", data: { checks: [{ id: "project.verify.green", status: "passed" }, ...checks] } }, "claude-code", 7);
    const reason = JSON.parse(result.stdout).reason as string;
    assert.match(reason, /^NOT VERIFIED/);
    assert.match(reason, /project\.verify\.check-0 \(failed\) Output: \.paved\/generated\/evidence\/check-0\.log/);
    assert.match(reason, /project\.verify\.check-1 \(blocked\): Not run on stale inputs/);
    assert.match(reason, /and 3 more/);
    assert.doesNotMatch(reason, /project\.verify\.green/);
    const excerpt = reason.split("\n").filter((line) => line.startsWith("    "));
    assert.equal(excerpt.length, 8);
    assert.ok(excerpt.join("").length <= 800 + 8 * 4);
    assert.ok(reason.length <= 2000);
  });

  it("falls back to diagnostic codes when no check is reported", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "Stop" },
      { command: "verify", status: "failed", diagnostics: [{ code: "PAVED_VERIFY_CHECK_DEPENDENCY_CYCLE", message: "cycle" }] }, "claude-code", 4);
    assert.match(JSON.parse(result.stdout).reason, /PAVED_VERIFY_CHECK_DEPENDENCY_CYCLE/);
  });

  it("does not block a warning and lists its pre-existing and environment-blocked checks on one line", () => {
    const f = fixture();
    const result = run(f, { hook_event_name: "Stop", stop_hook_active: false }, {
      command: "verify", status: "warning",
      data: {
        completion: { status: "incomplete", verification: "unverified" },
        unproven: [
          { id: "project.verify.front", status: "failed", reason: "pre-existing" },
          { id: "project.verify.integration", status: "blocked", reason: "environment-unavailable" },
          { id: "project.verify.e2e", status: "blocked", reason: "dependency-unproven" },
        ],
      },
    }, "claude-code", 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, undefined);
    assert.equal(output.systemMessage.split("\n").length, 1);
    assert.match(output.systemMessage, /pre-existing on the base: project\.verify\.front; environment unavailable: project\.verify\.integration; blocked by those: project\.verify\.e2e/);
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
