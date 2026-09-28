// Clean-room installation: the plugin is installed by the real Codex and Claude Code CLIs
// from a snapshot of what the GitHub repository serves, the snapshot is deleted, and every
// command runs through the installed launcher with no registry and an empty npm cache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { PLUGIN_DIRECTORY, runtimeFileName } from "../../plugins/build.ts";
import { CORE_VERSION, NEXT_MAJOR_VERSION, NEXT_PATCH_VERSION, ROOT } from "../helpers.ts";
import {
  applicationDigest, claudeDetails, codeOf, consumer, hostAvailable, installWithClaude, installWithCodex,
  launcher, pluginVariant, remoteCacheEntries, repackRuntime, repositorySnapshot, workspace, type Invocation,
} from "./support.ts";

const RUNTIME = runtimeFileName(CORE_VERSION);

const hosts = hostAvailable("codex") && hostAvailable("claude");
const skip = hosts ? false : "the codex and claude CLIs are required for the clean-room install test";

interface Lock { runtime: { version: string; integrity: string; content_sha256: string } }

describe("clean-room plugin installation", { skip }, () => {
  let root = "";
  let codexPlugin = "";
  let claudePlugin = "";
  let npmCache = "";
  let claudeInventory = "";

  before(() => {
    root = workspace("clean-room");
    const marketplace = repositorySnapshot(root);
    codexPlugin = installWithCodex(marketplace, join(root, "codex-home"));
    claudePlugin = installWithClaude(marketplace, join(root, "claude-home"));
    // Claude Code resolves a directory marketplace in place, so its inventory is read
    // before the snapshot is removed; the installed copies must work without it.
    claudeInventory = claudeDetails(join(root, "claude-home"));
    rmSync(marketplace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    npmCache = join(root, "npm-cache");
    mkdirSync(npmCache);
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

  const lockOf = (project: string) => parse(readFileSync(join(project, ".paved", "paved.lock"), "utf8")) as Lock;
  const data = <T>(invocation: Invocation): T => invocation.json.data as T;
  const ok = (invocation: Invocation, label: string) => {
    assert.ok(invocation.status === 0 || invocation.status === 1, `${label}: ${invocation.stdout}${invocation.stderr}`);
    return invocation;
  };

  it("installs the committed plugin byte for byte in both hosts", () => {
    for (const installed of [codexPlugin, claudePlugin]) {
      assert.ok(!realpathSync(installed).startsWith(realpathSync(ROOT)), `${installed} must not be the development checkout`);
      for (const file of ["bin/paved.mjs", "bin/bootstrap.json", "provenance.json", RUNTIME, "skills/init/SKILL.md"]) {
        assert.deepEqual(readFileSync(join(installed, file)), readFileSync(join(ROOT, PLUGIN_DIRECTORY, file)), `${installed}: ${file}`);
      }
    }
    assert.ok(claudeInventory.includes(`Skills (${readdirSync(join(ROOT, PLUGIN_DIRECTORY, "skills")).length})`), claudeInventory);
    for (const name of ["init", "status", "feature", "verify", "context-discovery"]) assert.match(claudeInventory, new RegExp(`\\b${name}\\b`));
  });

  it("governs a repository end to end offline through the Codex-installed launcher", () => {
    const project = consumer(root, "codex-consumer", {
      "package.json": JSON.stringify({ name: "clean-consumer", private: true, type: "module" }),
      "src/feature.js": "export const enabled = false;\n",
    });
    const paved = launcher(codexPlugin, npmCache);
    const nested = join(project, "src");

    const initialized = ok(paved(nested, "init", "--json"), "init");
    assert.equal(data<{ initialized: boolean }>(initialized).initialized, true, initialized.stdout);
    const lock = lockOf(project);
    const bundled = JSON.parse(readFileSync(join(codexPlugin, "bin", "bootstrap.json"), "utf8")) as { version: string; integrity: string };
    assert.equal(lock.runtime.version, bundled.version);
    assert.equal(lock.runtime.integrity, bundled.integrity);
    assert.equal(readFileSync(join(project, ".paved", "runtime", ".gitignore"), "utf8").trim().split("\n").at(-1), "*");
    const tracked = spawnSync("git", ["status", "--porcelain", "--", ".paved/runtime"], { cwd: project, encoding: "utf8" });
    assert.equal(tracked.stdout, "", "the runtime is never offered for commit");

    const status = ok(paved(nested, "status", "--json"), "status");
    const coreRoot = data<{ coreRoot: string }>(status).coreRoot;
    assert.ok(coreRoot.startsWith(realpathSync(join(project, ".paved", "runtime", "versions"))), coreRoot);
    assert.ok(!coreRoot.startsWith(realpathSync(ROOT)));
    assert.deepEqual(remoteCacheEntries(npmCache), [], "nothing was fetched from a registry");
    const commands = ok(paved(project, "agent", "commands", "--json"), "agent commands");
    assert.equal(data<{ commands: unknown[] }>(commands).commands.length, 14);

    configureTesting(project, coreRoot);
    const baseline = applicationDigest(project);
    const planned = paved(project, "plan", "Enable the sample feature", "--json");
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.equal(data<{ workflow: { id: string } }>(planned).workflow.id, "core.feature");

    const failingTest = paved(project, "test", "--json");
    assert.notEqual(failingTest.status, 0, "the governed test observes the disabled feature");
    assert.equal(applicationDigest(project), baseline, "plan and test change no application file");

    const started = paved(project, "feature", "Enable the sample feature", "--json");
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const run = data<{ run: string }>(started).run;
    const advance = (...args: string[]) => paved(project, "feature", "--run", run, "--advance", ...args, "--json");
    assert.equal(advance("--note", "Scope understood").status, 0);
    assert.equal(advance("--note", "Architecture inspected").status, 0);
    writeFileSync(join(project, ".paved", "generated", "plan.md"), "Enable src/feature.js and prove it with the project test.\n");
    const awaiting = advance("--note", "Concrete implementation plan", "--evidence", ".paved/generated/plan.md");
    assert.equal(data<{ status: string }>(awaiting).status, "awaiting-approval");
    const blocked = advance();
    assert.equal(data<{ status: string }>(blocked).status, "awaiting-approval", "no approval record, no implementation");
    const runStatus = () => (parse(readFileSync(join(project, ".paved", "generated", "runs", `${run}.yaml`), "utf8")) as { status: string }).status;
    approve(project, run, "0".repeat(64));
    assert.notEqual(advance().status, 0, "an approval of another plan is rejected");
    approve(project, run, planSha(project, run), "agent");
    assert.notEqual(advance().status, 0, "an agent cannot approve its own plan");
    assert.equal(runStatus(), "awaiting-approval");
    approve(project, run, planSha(project, run));
    assert.equal(advance().status, 0);
    writeFileSync(join(project, "src", "feature.js"), "export const enabled = true;\n");
    assert.equal(advance("--note", "Implemented approved behavior").status, 0);
    const tested = advance();
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
    const verified = advance();
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.equal(data<{ currentPhase: string }>(verified).currentPhase, "evidence");
    const recorded = advance("--evidence", workflowEvidence(project, run));
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    assert.equal(advance("--note", "Reviewed the implementation and evidence").status, 0);
    const completed = advance();
    assert.equal(data<{ status: string }>(completed).status, "completed", completed.stdout);

    const passingTest = paved(project, "test", "--json");
    assert.equal(passingTest.status, 0, passingTest.stdout + passingTest.stderr);
    const verification = paved(project, "verify", "--json");
    assert.equal(verification.status, 0, verification.stdout + verification.stderr);
    assert.equal(verification.json.status, "success");

    for (const workflow of ["fix", "refactor"] as const) {
      const created = paved(project, workflow, `Sample ${workflow} request`, "--json");
      assert.equal(created.status, 0, created.stdout + created.stderr);
      const id = data<{ run: string }>(created).run;
      const resumed = paved(project, workflow, "--run", id, "--advance", "--note", "Expected behavior recorded", "--json");
      assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
      assert.equal(data<{ run: string }>(resumed).run, id);
    }

    for (const lockfile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) assert.ok(!existsSync(join(project, lockfile)), lockfile);
    const changed = spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    assert.deepEqual(changed.filter((line) => !/ (\.paved\/|AGENTS\.md)/.test(line)), [" M src/feature.js"], "only the approved change touched application files");
  });

  it("activates the Claude-installed launcher in a separate repository", () => {
    const project = consumer(root, "claude-consumer");
    const paved = launcher(claudePlugin, npmCache);
    ok(paved(project, "init", "--json"), "init");
    const coreRoot = data<{ coreRoot: string }>(ok(paved(project, "status", "--json"), "status")).coreRoot;
    assert.ok(coreRoot.startsWith(realpathSync(join(project, ".paved", "runtime"))), coreRoot);
    assert.equal(data<{ commands: unknown[] }>(paved(project, "agent", "commands", "--json")).commands.length, 14);
  });

  it("never switches runtime silently and upgrades and rolls back explicitly", () => {
    const project = consumer(root, "upgrade-consumer");
    const current = launcher(codexPlugin, npmCache);
    ok(current(project, "init", "--json"), "init");
    const before = readFileSync(join(project, ".paved", "paved.lock"));
    const oldCore = data<{ coreRoot: string }>(current(project, "status", "--json")).coreRoot;

    const tarball = join(codexPlugin, RUNTIME);
    const patch = repackRuntime(tarball, NEXT_PATCH_VERSION, root);
    const newer = launcher(pluginVariant(codexPlugin, root, `plugin-${NEXT_PATCH_VERSION}`, { ...patch, version: NEXT_PATCH_VERSION }), npmCache);
    const notified = ok(newer(project, "status", "--json"), "status with newer plugin");
    assert.match(notified.stderr, /PAVED_RUNTIME_UPDATE_AVAILABLE/);
    assert.equal(data<{ coreRoot: string }>(notified).coreRoot, oldCore, "the pinned runtime stays active");
    assert.deepEqual(readFileSync(join(project, ".paved", "paved.lock")), before);
    const inspected = newer(project, "runtime", "status", "--json");
    assert.equal(data<{ updateAvailable: boolean }>(inspected).updateAvailable, true);

    const upgraded = newer(project, "runtime", "upgrade", "--json");
    assert.ok(upgraded.status === 0 || upgraded.status === 1, upgraded.stdout + upgraded.stderr);
    assert.equal(data<{ changed: boolean }>(upgraded).changed, true, upgraded.stdout);
    assert.equal(lockOf(project).runtime.version, NEXT_PATCH_VERSION);
    assert.equal(lockOf(project).runtime.integrity, patch.integrity);
    const newCore = data<{ coreRoot: string }>(ok(newer(project, "status", "--json"), "status after upgrade")).coreRoot;
    assert.notEqual(newCore, oldCore);
    const stale = current(project, "status", "--json");
    assert.match(stale.stderr, /PAVED_RUNTIME_UPDATE_AVAILABLE/, "an older plugin does not downgrade the project either");
    assert.equal(data<{ coreRoot: string }>(stale).coreRoot, newCore);

    const rolledBack = newer(project, "runtime", "rollback", "--json");
    assert.equal(rolledBack.status, 0, rolledBack.stdout + rolledBack.stderr);
    assert.deepEqual(readFileSync(join(project, ".paved", "paved.lock")), before);
    assert.equal(data<{ coreRoot: string }>(ok(current(project, "status", "--json"), "status after rollback")).coreRoot, oldCore);
    assert.equal(codeOf(newer(project, "runtime", "rollback", "--json")), "PAVED_RUNTIME_ROLLBACK_UNAVAILABLE");

    const major = repackRuntime(tarball, NEXT_MAJOR_VERSION, root);
    const incompatible = launcher(pluginVariant(codexPlugin, root, `plugin-${NEXT_MAJOR_VERSION}`, { ...major, version: NEXT_MAJOR_VERSION }), npmCache);
    const refused = incompatible(project, "runtime", "upgrade", "--json");
    assert.equal(refused.status, 5, refused.stdout + refused.stderr);
    assert.ok(refused.json.diagnostics?.some((entry) => entry.code === "PAVED_RUNTIME_UPGRADE_FAILED"), refused.stdout);
    assert.deepEqual(readFileSync(join(project, ".paved", "paved.lock")), before, "a failed upgrade leaves the lock untouched");
    assert.ok(!existsSync(join(project, ".paved", "runtime", "rollback.json")));
    assert.equal(data<{ coreRoot: string }>(ok(current(project, "status", "--json"), "status after refusal")).coreRoot, oldCore);
  });
});

function configureTesting(project: string, coreRoot: string): void {
  const paved = join(project, ".paved");
  for (const dir of ["tools", "tool-implementations", join("verification", "checks")]) mkdirSync(join(paved, dir), { recursive: true });
  const tool = parse(readFileSync(join(coreRoot, "core", "tools", "testing", "run.yaml"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(paved, "tools", "testing.yaml"), stringify({ ...tool, id: "project.testing.run" }));
  writeFileSync(join(paved, "tool-implementations", "testing.yaml"), stringify({
    apiVersion: "paved/v1", kind: "ToolImplementation", id: "project.testing.run", tool: "project.testing.run",
    version: "1.0.0", contract: "^0.1.0", source: "project", environments: ["local"],
    invocation: { type: "command", executable: process.execPath, arguments: ["--", ".paved/tools/test-runner.mjs"] },
    availability: "available",
  }));
  writeFileSync(join(paved, "tools", "feature.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { enabled } from "../../src/feature.js";',
    'test("feature is enabled", () => assert.equal(enabled, true));',
  ].join("\n"));
  writeFileSync(join(paved, "tools", "test-runner.mjs"), [
    'import { spawnSync } from "node:child_process";',
    'const run = spawnSync(process.execPath, ["--test", ".paved/tools/feature.test.mjs"], {cwd: process.cwd(), encoding: "utf8", shell: false});',
    'process.stdout.write(JSON.stringify({status: run.status === 0 ? "passed" : "failed", output: run.stdout ?? ""}));',
    "process.exitCode = run.status ?? 1;",
  ].join("\n"));
  writeFileSync(join(paved, "verification", "checks", "unit.yaml"), stringify({
    apiVersion: "paved/v1", kind: "Check", id: "project.verify.feature", title: "Feature regression",
    purpose: "Prove the approved feature behavior.", type: "unit", tool: "project.testing.run", inputs: {},
    expected: { description: "Feature test passes.", exit_code: 0 }, timeout_seconds: 10,
    environment: { kinds: ["local"] }, failure: "Feature regression failed.",
    determinism: { class: "deterministic" }, retry: { class: "non-retryable" },
  }));
  writeFileSync(join(paved, "verification", "profile.yaml"), stringify({
    apiVersion: "paved/v1", kind: "VerificationProfile", checks: ["project.verify.feature"], policy: { minimum_recorder: "agent" },
  }));
}

function planSha(project: string, run: string): string {
  const workflow = parse(readFileSync(join(project, ".paved", "generated", "runs", `${run}.yaml`), "utf8")) as { phases: { phase: string; gates?: { reason?: string }[] }[] };
  const sha = workflow.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.reason?.startsWith("plan_sha256="))?.reason?.slice(12);
  assert.ok(sha, "the planning gate records the plan digest");
  return sha;
}

function approve(project: string, run: string, sha: string, decidedBy = "maintainer"): void {
  mkdirSync(join(project, ".paved", "approvals"), { recursive: true });
  writeFileSync(join(project, ".paved", "approvals", `${run}.json`), JSON.stringify({
    run, plan_sha256: sha, decision: "approved", decided_by: decidedBy, decided_at: new Date().toISOString(),
  }));
}

function workflowEvidence(project: string, run: string): string {
  const state = parse(readFileSync(join(project, ".paved", "generated", "runs", `${run}.yaml`), "utf8")) as { evidence: string };
  const authoritative = parse(readFileSync(join(project, state.evidence), "utf8")) as Record<string, unknown>;
  const diff = spawnSync("git", ["diff", "HEAD", "--", "src/feature.js"], { cwd: project, encoding: "utf8", shell: false }).stdout;
  assert.match(diff, /\+export const enabled = true/);
  const diffRef = ".paved/generated/evidence/feature-diff.md";
  writeFileSync(join(project, diffRef), diff);
  const change = authoritative.change as { revision: string };
  const evidenceRef = ".paved/generated/evidence/feature-evidence.yaml";
  writeFileSync(join(project, evidenceRef), stringify({
    ...authoritative,
    id: "feature-evidence",
    producer: { agent: "paved-cli", workflow: "core.feature" },
    change: { ...change, summary: "Enabled the sample feature." },
    plan: { required: ["unit"], recommended: ["build", "static-analysis", "unit", "integration", "e2e"], evidence: ["check-result", "diff"] },
    artifacts: [...(authoritative.artifacts as unknown[]), {
      id: "feature-diff", kind: "diff", description: "Observed change to the feature module.",
      recorded_by: "agent", revision: change.revision, created_at: new Date().toISOString(),
      source: { type: "file", location: diffRef, sha256: createHash("sha256").update(diff).digest("hex") },
    }],
  }));
  return evidenceRef;
}
