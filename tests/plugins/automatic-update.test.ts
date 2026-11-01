import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { ROOT, schemas } from "../helpers.ts";
import { consumer, pluginVariant, repackRuntime } from "./support.ts";

const workspace = join(ROOT, "node_modules/.auto-update-tests");
const runtimeVersion = JSON.parse(readFileSync(join(ROOT, "plugins/paved/runtime/paved-core/package.json"), "utf8")).version as string;
mkdirSync(workspace, { recursive: true });
after(() => rmSync(workspace, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
  const root = join(workspace, String(sequence++));
  const plugin = join(root, "plugin");
  const project = join(root, "project");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const path of [join(plugin, "scripts"), join(project, ".paved"), home, bin]) mkdirSync(path, { recursive: true });
  for (const [source, target] of [["bootstrap.mjs", "paved.mjs"], ["auto-update.mjs", "auto-update.mjs"]]) {
    if (existsSync(join(ROOT, "integrations/shared", source!))) cpSync(join(ROOT, "integrations/shared", source!), join(plugin, "scripts", target!));
  }
  writeFileSync(join(plugin, "scripts/bootstrap.json"), JSON.stringify({ package: "paved-core", version: runtimeVersion, runtime: "../runtime", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }));
  writeFileSync(join(project, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\n");
  writeFileSync(join(project, ".paved/paved.lock"), "apiVersion: paved/v1\nkind: Lock\n");
  const log = join(root, "commands.jsonl");
  const inventory = join(root, "inventory.json");
  writeFileSync(inventory, JSON.stringify([{ id: "paved@paved", scope: "user", installPath: plugin }]));
  const refreshed = join(root, "refreshed");
  mkdirSync(join(refreshed, "scripts"), { recursive: true });
  writeFileSync(join(refreshed, "scripts/paved.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync('.paved/adopted', 'refreshed'); console.log(JSON.stringify({command:'update',status:'success',data:{changed:true}}));`);
  for (const host of ["claude", "codex"]) {
    writeFileSync(join(bin, host), `#!${process.execPath}\nimport {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(host)},...args])+'\\n');
if(args.includes('list')) console.log(readFileSync(${JSON.stringify(inventory)},'utf8'));
else if(existsSync(${JSON.stringify(join(root, "fail"))})) process.exit(1);
else if(args.includes('update') && args.includes('paved@paved')) {
const items=JSON.parse(readFileSync(${JSON.stringify(inventory)},'utf8')); items[0].installPath=${JSON.stringify(refreshed)}; writeFileSync(${JSON.stringify(inventory)},JSON.stringify(items));
} else if(args.includes('add')) console.log(JSON.stringify({installedPath:${JSON.stringify(refreshed)}}));
`, { mode: 0o755 });
  }
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), PATH: `${bin}:${process.env.PATH}`, CI: "", GITHUB_ACTIONS: "", PAVED_DRY_RUN: "" };
  const run = (args: string[], cwd = project, overrides: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [join(plugin, "scripts/paved.mjs"), "auto-update", ...args, "--json"], { cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 });
    return { ...result, json: JSON.parse(result.stdout || "{}") as any };
  };
  const commands = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]) : [];
  const configure = (mode = "auto", host = "claude-code") => run(["configure", "--mode", mode, "--host", host]);
  return { root, project, plugin, home, inventory, refreshed, run, commands, configure, env };
}

describe("authorized plugin automatic updates", () => {
  it("is disabled without authorization and performs no writes or host probes", () => {
    const f = fixture();
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "disabled");
    assert.equal(f.run(["status"]).json.data.config.mode, "off");
    assert.deepEqual(f.commands(), []);
    assert.equal(existsSync(join(f.project, ".paved/auto-update.json")), false);
    assert.equal(existsSync(join(f.home, ".cache")), false);
  });
  it("requires an explicit allowed host and rejects command/path configuration", () => {
    const f = fixture();
    for (const args of [
      ["configure", "--mode", "auto"], ["configure", "--mode", "auto", "--host", "/evil"],
      ["configure", "--mode", "auto", "--host", "claude-code", "--launcher", "/evil"],
      ["configure", "--mode", "auto", "--host", "claude-code", "--interval-hours", "0"],
    ]) assert.equal(f.run(args).json.status, "failed");
    assert.deepEqual(f.commands(), []);
  });
  it("persists authorization only on configure and suppresses CI and dry runs", () => {
    const f = fixture();
    assert.equal(f.configure().json.status, "success");
    assert.equal(f.run(["status"]).json.data.config.intervalHours, 24);
    const before = readFileSync(join(f.project, ".paved/auto-update.json"), "utf8");
    for (const overrides of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { PAVED_DRY_RUN: "true" }]) {
      assert.equal(f.run(["check", "--host", "claude-code"], f.project, overrides).json.data.reason, "suppressed");
    }
    assert.equal(f.run(["check", "--host", "claude-code", "--dry-run"]).json.data.reason, "suppressed");
    assert.equal(readFileSync(join(f.project, ".paved/auto-update.json"), "utf8"), before);
    assert.deepEqual(f.commands(), []);
  });
  it("never substitutes Codex for Cursor or another host", () => {
    const f = fixture();
    f.configure("auto", "codex");
    assert.equal(f.run(["check", "--host", "cursor"]).json.data.reason, "unsupported-host");
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "host-mismatch");
    assert.equal(f.run(["check"]).json.data.reason, "host-required");
    assert.deepEqual(f.commands(), []);
  });
  it("refreshes only the installed Claude scope and adopts the refreshed launcher", () => {
    const f = fixture();
    f.configure();
    const checked = f.run(["check", "--host", "claude-code"]);
    assert.equal(checked.json.status, "success", checked.stdout + checked.stderr);
    assert.equal(readFileSync(join(f.project, ".paved/adopted"), "utf8"), "refreshed");
    assert.deepEqual(f.commands().filter(args => !args.includes("list")), [
      ["claude", "plugin", "marketplace", "update", "paved"],
      ["claude", "plugin", "update", "paved@paved", "--scope", "user"],
    ]);
    assert.equal(checked.json.data.restartRequired, true);
    const count = f.commands().length;
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "not-due");
    assert.equal(f.commands().length, count);
  });
  it("shares host refresh throttle without starving a second project adoption", () => {
    const f = fixture();
    const second = join(f.root, "second");
    cpSync(f.project, second, { recursive: true });
    f.configure();
    f.run(["configure", "--mode", "auto", "--host", "claude-code"], second);
    f.run(["check", "--host", "claude-code"]);
    assert.equal(f.run(["check", "--host", "claude-code"], second).json.status, "success");
    assert.equal(readFileSync(join(second, ".paved/adopted"), "utf8"), "refreshed");
    assert.equal(f.commands().filter(args => args.includes("marketplace")).length, 1);
  });
  it("uses the verified Codex installed collection and add result without probing Claude", () => {
    const f = fixture();
    writeFileSync(f.inventory, JSON.stringify({ installed: [{ pluginId: "paved@paved", name: "paved", marketplaceName: "paved", installed: true, enabled: true, version: "2.20.0", installedPath: f.plugin }], available: [] }));
    f.configure("auto", "codex");
    const result = f.run(["check", "--host", "codex"]);
    assert.equal(result.json.status, "success", result.stdout);
    assert.equal(readFileSync(join(f.project, ".paved/adopted"), "utf8"), "refreshed");
    assert.deepEqual(f.commands().filter(args => !args.includes("list")), [
      ["codex", "plugin", "marketplace", "upgrade", "paved"],
      ["codex", "plugin", "add", "paved@paved", "--json"],
    ]);
  });
  it("rediscovers inventory under the shared lock instead of using a pre-refresh race snapshot", () => {
    const f = fixture();
    f.configure();
    f.run(["check", "--host", "claude-code"]);
    const second = join(f.root, "racing-project");
    cpSync(f.project, second, { recursive: true });
    rmSync(join(second, ".paved/adopted"));
    f.run(["configure", "--mode", "auto", "--host", "claude-code"], second);
    const marker = join(f.root, "race-inventory-returned");
    writeFileSync(join(f.root, "bin/claude"), `#!${process.execPath}\nimport {existsSync,readFileSync,writeFileSync} from 'node:fs';
      if(!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},'');console.log(JSON.stringify([{id:'paved@paved',scope:'user',installPath:${JSON.stringify(f.plugin)}}]));}
      else console.log(readFileSync(${JSON.stringify(f.inventory)},'utf8'));`, { mode: 0o755 });
    const result = f.run(["check", "--host", "claude-code"], second);
    assert.equal(result.json.status, "success", result.stdout);
    assert.equal(readFileSync(join(second, ".paved/adopted"), "utf8"), "refreshed");
  });
  it("preserves an expired installation refresh lock and leaves project adoption due", () => {
    const f = fixture();
    f.configure();
    f.run(["check", "--host", "claude-code"]);
    f.configure();
    const directory = join(f.home, ".cache/paved/auto-update");
    const stateFile = readdirSync(directory).find(name => name.endsWith(".json"))!;
    const lock = join(directory, `${stateFile}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: -1, started_at: "2000-01-01T00:00:00Z" }));
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "host-busy");
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(join(f.project, ".paved/auto-update-state.json")), false);
    rmSync(lock, { recursive: true });
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "updated");
    assert.equal(f.commands().filter(args => args.includes("marketplace")).length, 1);
  });
  it("runs due checks deterministically from both hook events without losing reminders", () => {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const f = fixture();
      mkdirSync(join(f.plugin, "hooks"));
      cpSync(join(ROOT, "integrations/shared/prompt-submit-hook.mjs"), join(f.plugin, "hooks/paved-prompt-submit.mjs"));
      f.configure();
      const result = spawnSync(process.execPath, [join(f.plugin, "hooks/paved-prompt-submit.mjs"), "--host", "claude-code"], {
        cwd: f.project, encoding: "utf8", timeout: 30000,
        input: JSON.stringify({ cwd: f.project, hook_event_name: event, source: "startup" }),
        env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: join(f.home, "claude"), PATH: `${join(f.root, "bin")}:${process.env.PATH}`, CI: "", GITHUB_ACTIONS: "" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, event);
      assert.equal(existsSync(join(f.project, ".paved/adopted")), true, "the hook, not a model, must initiate the update");
    }
  });
  it("portable hooks fail closed without Codex-managed plugin context even with CODEX_HOME", () => {
    const f = fixture();
    mkdirSync(join(f.plugin, "hooks"));
    cpSync(join(ROOT, "integrations/shared/prompt-submit-hook.mjs"), join(f.plugin, "hooks/paved-prompt-submit.mjs"));
    f.configure("auto", "codex");
    const result = spawnSync(process.execPath, [join(f.plugin, "hooks/paved-prompt-submit.mjs"), "--host", "codex"], {
      cwd: f.project, encoding: "utf8", timeout: 30000, input: JSON.stringify({ cwd: f.project }),
      env: { ...process.env, HOME: f.home, CODEX_HOME: join(f.home, "codex"), PLUGIN_ROOT: f.plugin, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, CI: "" },
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(f.commands(), []);
  });
  it("Codex-managed portable hooks identify Codex positively at session start and prompts", () => {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const f = fixture();
      f.configure("auto", "codex");
      const codexHome = join(f.home, "codex");
      const installed = join(codexHome, "plugins/cache/paved/paved/2.20.0");
      mkdirSync(installed, { recursive: true });
      cpSync(join(f.plugin, "scripts"), join(installed, "scripts"), { recursive: true });
      mkdirSync(join(installed, "hooks"));
      cpSync(join(ROOT, "integrations/shared/prompt-submit-hook.mjs"), join(installed, "hooks/paved-prompt-submit.mjs"));
      const result = spawnSync(process.execPath, [join(installed, "hooks/paved-prompt-submit.mjs"), "--host", "codex"], {
        cwd: f.project, encoding: "utf8", timeout: 30000,
        input: JSON.stringify({ cwd: f.project, hook_event_name: event, source: "startup" }),
        env: { ...f.env, PLUGIN_ROOT: installed, CODEX_HOME: codexHome },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, event);
      assert.equal(existsSync(join(f.project, ".paved/adopted")), true);
      assert.equal(f.commands().every(args => args[0] === "codex"), true);
    }
  });
  it("linked worktree hooks use shared authorization but manage the initiating checkout scope", () => {
    const f = fixture();
    const checkout = join(f.root, "checkout");
    const gitDir = join(f.project, ".git/worktrees/checkout");
    mkdirSync(checkout);
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    mkdirSync(join(f.plugin, "hooks"));
    cpSync(join(ROOT, "integrations/shared/prompt-submit-hook.mjs"), join(f.plugin, "hooks/paved-prompt-submit.mjs"));
    writeFileSync(f.inventory, JSON.stringify([{ id: "paved@paved", scope: "project", projectPath: checkout, installPath: f.plugin }]));
    const hostCwd = join(f.root, "host-cwd");
    const stub = join(f.root, "bin/claude");
    writeFileSync(stub, readFileSync(stub, "utf8").replace("\nconst args=", `\nwriteFileSync(${JSON.stringify(hostCwd)},process.cwd());\nconst args=`), { mode: 0o755 });
    writeFileSync(join(f.refreshed, "scripts/paved.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(f.project, ".paved/adopted"))},'shared');console.log(JSON.stringify({command:'update',status:'success',data:{changed:true}}));`);
    f.configure();
    const result = spawnSync(process.execPath, [join(f.plugin, "hooks/paved-prompt-submit.mjs"), "--host", "claude-code"], {
      cwd: checkout, encoding: "utf8", timeout: 30000, input: JSON.stringify({ cwd: checkout }), env: f.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Restart this agent session/);
    assert.equal(readFileSync(hostCwd, "utf8"), checkout);
    assert.equal(readFileSync(join(f.project, ".paved/adopted"), "utf8"), "shared");
    assert.equal(existsSync(join(checkout, ".paved")), false);
    assert.deepEqual(f.commands().find(args => args.includes("paved@paved")), ["claude", "plugin", "update", "paved@paved", "--scope", "project"]);
  });
  it("Codex inventory versions resolve only the documented installed cache, not source paths", () => {
    const f = fixture();
    f.configure("auto", "codex");
    const installed = join(f.home, "codex/plugins/cache/paved/paved/2.20.0");
    mkdirSync(join(installed, "scripts"), { recursive: true });
    cpSync(join(f.plugin, "scripts/paved.mjs"), join(installed, "scripts/paved.mjs"));
    writeFileSync(f.inventory, JSON.stringify({ installed: [{ pluginId: "paved@paved", installed: true, enabled: true, version: "2.20.0", source: { path: "/untrusted/source" } }], available: [] }));
    assert.equal(f.run(["check", "--host", "codex"]).json.status, "success");
    assert.equal(readFileSync(join(f.project, ".paved/adopted"), "utf8"), "refreshed");
  });
  it("defers active workflows and operation locks without consuming adoption", () => {
    const f = fixture();
    f.configure();
    mkdirSync(join(f.project, ".paved/generated/runs"), { recursive: true });
    const run = join(f.project, ".paved/generated/runs/change.yaml");
    writeFileSync(run, "apiVersion: paved/v1\nkind: WorkflowRun\nstatus: awaiting-approval\n");
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "project-busy");
    rmSync(run);
    mkdirSync(join(f.project, ".paved-operation-lock"));
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "project-busy");
    rmSync(join(f.project, ".paved-operation-lock"), { recursive: true });
    assert.equal(f.run(["check", "--host", "claude-code"]).json.status, "success");
    assert.equal(existsSync(join(f.project, ".paved/adopted")), true);
  });
  it("does not install absent plugins and backs off failed host stages", () => {
    const absent = fixture();
    absent.configure();
    writeFileSync(absent.inventory, "[]");
    assert.equal(absent.run(["check", "--host", "claude-code"]).json.data.reason, "not-installed");
    assert.equal(absent.commands().filter(args => !args.includes("list")).length, 0);
    const f = fixture();
    f.configure();
    writeFileSync(join(f.root, "fail"), "");
    assert.equal(f.run(["check", "--host", "claude-code"]).json.status, "failed");
    const count = f.commands().length;
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "backoff");
    assert.equal(f.commands().length, count);
    assert.equal(existsSync(join(f.project, ".paved/adopted")), false);
  });
  it("notify is read-only and distinguishes installed from upstream freshness", () => {
    const f = fixture();
    f.configure("notify");
    const result = f.run(["check", "--host", "claude-code"]);
    assert.equal(result.json.data.upstream, "unknown");
    assert.equal(result.json.data.reason, "notification");
    assert.equal(f.commands().filter(args => !args.includes("list")).length, 0);
    assert.equal(existsSync(join(f.project, ".paved/adopted")), false);
    assert.equal(existsSync(join(f.home, ".cache")), false);
    const count = f.commands().length;
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "not-due");
    assert.equal(f.commands().length, count);
    assert.equal(existsSync(join(f.project, ".paved/runtime")), false, "notification writes metadata, not runtime artifacts");
  });
  it("a due interval permits refresh again, but another scope has its own throttle", () => {
    const f = fixture();
    f.configure();
    f.run(["check", "--host", "claude-code"]);
    const sharedDirectory = join(f.home, ".cache/paved/auto-update");
    const stateFiles = readdirSync(sharedDirectory).filter(name => name.endsWith(".json"));
    for (const path of [join(f.project, ".paved/auto-update-state.json"), ...stateFiles.map(name => join(sharedDirectory, name))]) {
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.lastSuccess = Date.now() - 25 * 3600000;
      writeFileSync(path, JSON.stringify(value));
    }
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "updated");
    assert.equal(f.commands().filter(args => args.includes("marketplace")).length, 2);
    writeFileSync(f.inventory, JSON.stringify([{ id: "paved@paved", scope: "project", projectPath: f.project, installPath: f.refreshed }]));
    f.configure();
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "updated");
    assert.deepEqual(f.commands().filter(args => args.includes("paved@paved")).at(-1), ["claude", "plugin", "update", "paved@paved", "--scope", "project"]);
    assert.equal(f.commands().filter(args => args.includes("marketplace")).length, 3);
  });
  it("an adoption failure reports completed host stages and backs off without re-refreshing", () => {
    const f = fixture();
    f.configure();
    writeFileSync(join(f.refreshed, "scripts/paved.mjs"), `console.log(JSON.stringify({command:'update',status:'failed',diagnostics:[{code:'INCOMPATIBLE'}]}));process.exit(5);`);
    const result = f.run(["check", "--host", "claude-code"]);
    assert.equal(result.json.status, "failed");
    assert.deepEqual(result.json.data.completed, ["inventory", "marketplace", "plugin"]);
    assert.equal(result.json.data.update.diagnostics[0].code, "INCOMPATIBLE");
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "backoff");
    assert.equal(f.commands().filter(args => args.includes("marketplace")).length, 1);
  });
  it("the real refreshed launcher upgrades transactionally and rejects corrupt/incompatible runtimes", () => {
    const [major, minor, patch] = runtimeVersion.split(".").map(Number) as [number, number, number];
    const compatibleVersion = `${major}.${minor}.${patch + 1}`;
    const incompatibleVersion = `${major + 1}.0.0`;
    for (const candidate of ["compatible", "incompatible", "corrupt"]) {
      const f = fixture();
      rmSync(join(f.project, ".paved"), { recursive: true });
      consumer(f.root, "project");
      cpSync(join(ROOT, "plugins/paved"), f.plugin, { recursive: true });
      const init = spawnSync(process.execPath, [join(f.plugin, "scripts/paved.mjs"), "init", "--json"], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 30000 });
      assert.ok(init.status === 0 || init.status === 1, init.stdout + init.stderr);
      assert.equal(existsSync(join(f.project, ".paved/auto-update.json")), false, "ordinary init never opts in");
      const beforeLock = readFileSync(join(f.project, ".paved/paved.lock"), "utf8");
      const beforeSelection = readFileSync(join(f.project, ".paved/runtime/selection.json"), "utf8");
      const version = candidate === "incompatible" ? incompatibleVersion : compatibleVersion;
      const runtime = repackRuntime(join(f.plugin, "runtime/paved-core"), version, f.root);
      rmSync(f.refreshed, { recursive: true });
      pluginVariant(f.plugin, f.root, "refreshed", { ...runtime, version });
      if (candidate === "corrupt") writeFileSync(join(f.refreshed, "runtime/paved-core/VERSION"), "tampered\n");
      f.configure();
      const updated = f.run(["check", "--host", "claude-code"]);
      if (candidate === "compatible") {
        assert.equal(updated.json.status, "success", updated.stdout + updated.stderr);
        const lock = parse(readFileSync(join(f.project, ".paved/paved.lock"), "utf8"));
        assert.equal(lock.core.version, compatibleVersion);
        assert.equal(lock.runtime.version, compatibleVersion);
        assert.equal(existsSync(join(f.project, ".paved-operation-lock")), false);
      } else {
        assert.equal(updated.json.status, "failed", updated.stdout);
        assert.equal(readFileSync(join(f.project, ".paved/paved.lock"), "utf8"), beforeLock);
        assert.equal(readFileSync(join(f.project, ".paved/runtime/selection.json"), "utf8"), beforeSelection);
      }
    }
  });
  it("a malformed terminal workflow record defers rather than being migrated", () => {
    const f = fixture();
    f.configure();
    mkdirSync(join(f.project, ".paved/generated/runs"), { recursive: true });
    writeFileSync(join(f.project, ".paved/generated/runs/bad.yaml"), "apiVersion: paved/v1\nkind: WorkflowRun\nstatus: completed\n");
    assert.equal(f.run(["check", "--host", "claude-code"]).json.data.reason, "project-busy");
    assert.deepEqual(f.commands(), []);
  });
  it("defers contradictory completed records with unfinished phases but accepts completed phases", () => {
    for (const phaseStatus of ["pending", "running", "completed"]) {
      const f = fixture();
      cpSync(join(ROOT, "plugins/paved/runtime"), join(f.plugin, "runtime"), { recursive: true });
      f.configure();
      const run = {
        apiVersion: "paved/v1", kind: "WorkflowRun", id: "intent-finished", revision: "HEAD",
        started_at: "2026-11-01T10:00:00Z", ended_at: "2026-11-01T11:00:00Z",
        status: "completed", workflow: { id: "core.feature", version: "0.1.0" },
        inputs: [], phases: [{ phase: "implementation", status: phaseStatus, attempts: 1 }],
        evidence: ".paved/generated/evidence/intent-finished.yaml",
      };
      assert.equal(schemas().validate(run).valid, true, "the structural schema permits inconsistent phase status");
      mkdirSync(join(f.project, ".paved/generated/runs"), { recursive: true });
      writeFileSync(join(f.project, ".paved/generated/runs/finished.yaml"), stringify(run));
      const checked = f.run(["check", "--host", "claude-code"]).json;
      if (phaseStatus === "completed") {
        assert.equal(checked.status, "success");
        assert.equal(readFileSync(join(f.project, ".paved/adopted"), "utf8"), "refreshed");
      } else {
        assert.equal(checked.data.reason, "project-busy");
        assert.deepEqual(f.commands(), []);
        assert.equal(existsSync(join(f.project, ".paved/auto-update-state.json")), false);
      }
    }
  });
  it("refuses symlink authorization and unexpected executable paths", () => {
    const f = fixture();
    f.configure();
    const config = join(f.project, ".paved/auto-update.json");
    cpSync(config, join(f.root, "config"));
    rmSync(config);
    symlinkSync(join(f.root, "config"), config);
    assert.equal(f.run(["check", "--host", "claude-code"]).json.status, "failed");
    assert.deepEqual(f.commands(), []);
    const poisoned = fixture();
    poisoned.configure();
    const executable = join(poisoned.project, "host-executable");
    cpSync(join(poisoned.root, "bin/claude"), executable);
    rmSync(join(poisoned.root, "bin/claude"));
    symlinkSync(executable, join(poisoned.root, "bin/claude"));
    assert.equal(poisoned.run(["check", "--host", "claude-code"]).json.status, "failed");
    assert.deepEqual(poisoned.commands(), []);
  });
});
