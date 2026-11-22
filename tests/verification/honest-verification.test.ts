import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { runVerification } from "../../cli/lib/verification-runner.ts";
import { acquireConsumerOperationLock } from "../../cli/lib/operation-lock.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { exitCode, type CommandResult } from "../../cli/result.ts";
import { schemas } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE = join(ROOT, "tests/cli/fixtures/verification");
const SANDBOXES = join(ROOT, "tests/verification/.sandbox-honest");
let counter = 0;
after(() => rmSync(SANDBOXES, { recursive: true, force: true }));

const PROBE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args[args.indexOf("--file") + 1];
mkdirSync(".paved/generated", { recursive: true });
appendFileSync(".paved/generated/probe-calls", file + "\\n");
if (existsSync("big.txt")) process.stdout.write("filler line\\n".repeat(2500));
if (process.env.PAVED_PROBE_VALUE !== undefined) console.log("value=" + process.env.PAVED_PROBE_VALUE);
const lines = existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean) : [];
for (const line of lines) console.log(line);
process.exit(lines.some((line) => line.startsWith("FAIL")) ? 1 : 0);
`;

interface CheckOptions {
  readonly file?: string;
  readonly depends_on?: string[];
  readonly requires?: { files?: string[]; variables?: string[] };
  readonly applies_to?: string[];
}

function sandbox(name: string, checks: Record<string, CheckOptions>): string {
  const dir = join(SANDBOXES, `${name}-${process.pid}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, ".paved/tools/probe.mjs"), PROBE);
  chmodSync(join(dir, ".paved/tools/probe.mjs"), 0o755);
  const marker = parse(readFileSync(join(dir, ".paved/tools/marker.yaml"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, ".paved/tools/probe.yaml"), stringify({
    ...marker, id: "project.tool.probe", title: "Probe Tool", capability: "probe",
    inputs: [{ name: "file", description: "State file to report.", type: "string", required: true }],
  }));
  const implementation = parse(readFileSync(join(dir, ".paved/tool-implementations/marker.yaml"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, ".paved/tool-implementations/probe.yaml"), stringify({
    ...implementation, id: "project.tool.probe", tool: "project.tool.probe",
    invocation: { type: "command", executable: ".paved/tools/probe.mjs", arguments: [], input_bindings: [{ input: "file", flag: "--file" }], timeout_seconds: 5 },
  }));
  const template = parse(readFileSync(join(dir, ".paved/verification/checks/marker.yaml"), "utf8")) as Record<string, unknown>;
  for (const [id, options] of Object.entries(checks)) {
    writeFileSync(join(dir, `.paved/verification/checks/${id.split(".").at(-1)}.yaml`), stringify({
      ...template, id, title: `Probe ${id}`, tool: "project.tool.probe", inputs: { file: options.file ?? "state.txt" },
      ...(options.depends_on ? { depends_on: options.depends_on } : {}),
      ...(options.applies_to ? { applies_to: options.applies_to } : {}),
      environment: { kinds: ["local"], ...(options.requires ? { requires: options.requires } : {}) },
    }));
  }
  writeFileSync(join(dir, ".paved/verification/profile.yaml"), stringify({
    apiVersion: "paved/v1", kind: "VerificationProfile", checks: Object.keys(checks), policy: { minimum_recorder: "agent" },
  }));
  return dir;
}

function git(project: string, ...args: string[]): string {
  return execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" });
}

/** A repository whose main branch holds `base` in state.txt and whose feature branch is checked out. */
function repository(project: string, base: string): void {
  writeFileSync(join(project, ".gitignore"), ".paved/generated/\n");
  writeFileSync(join(project, "state.txt"), base);
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "base");
  git(project, "checkout", "-qb", "feature");
}

function calls(project: string): string[] {
  const path = join(project, ".paved/generated/probe-calls");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function records(project: string): Record<string, unknown>[] {
  const dir = join(project, ".paved/generated/evidence");
  return readdirSync(dir).filter((name) => name.endsWith(".yaml")).sort().map((name) => {
    const record = parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    const validation = schemas().validate(record);
    assert.ok(validation.valid, validation.errors.join("\n"));
    return record;
  });
}

type RecordedCheck = { check: string; status: string; reason?: string; missing_environment?: unknown; blocked_by?: string[]; pre_existing?: boolean; baseline?: { status: string; output_ref?: string; reused_from?: string } };

function recordedChecks(project: string): RecordedCheck[] {
  return records(project).at(-1)!.checks as RecordedCheck[];
}

async function cli(project: string, ...args: string[]): Promise<CommandResult> {
  return dispatchCli({ argv: ["verify", "--project", project, ...args], cwd: ROOT, executablePath: join(ROOT, "cli/index.ts") });
}

describe("environment requirements", () => {
  it("blocks a check whose required file or variable is missing, naming them without running it", async () => {
    const project = sandbox("env-missing", {
      "project.verify.integration": { requires: { files: [".env"], variables: ["PAVED_PROBE_ABSENT"] } },
    });
    delete process.env.PAVED_PROBE_ABSENT;
    const result = await cli(project, "--json");

    assert.equal(result.status, "warning", JSON.stringify(result));
    assert.equal(exitCode(result), 1);
    assert.deepEqual(calls(project), [], "a blocked check never runs");
    const [check] = recordedChecks(project);
    assert.equal(check!.status, "blocked");
    assert.deepEqual(check!.missing_environment, { files: [".env"], variables: ["PAVED_PROBE_ABSENT"] });
    const diagnostic = result.diagnostics.find((item) => item.code === "PAVED_CHECK_ENVIRONMENT_UNAVAILABLE");
    assert.match(diagnostic?.message ?? "", /missing file \.env; missing variable PAVED_PROBE_ABSENT/);
    const data = result.data as { unproven: { id: string; reason: string; missing: unknown }[] };
    assert.deepEqual(data.unproven.map(({ id, reason }) => [id, reason]), [["project.verify.integration", "environment-unavailable"]]);
  });

  it("runs once the requirements are present, passing declared variables and scrubbing their values", async () => {
    const project = sandbox("env-present", {
      "project.verify.integration": { requires: { files: [".env"], variables: ["PAVED_PROBE_VALUE"] } },
    });
    writeFileSync(join(project, ".env"), "SECRET=never-read\n");
    process.env.PAVED_PROBE_VALUE = "probe-secret-value";
    try {
      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      assert.equal(result.status, "success", JSON.stringify(result.diagnostics));
      const log = readFileSync(join(project, result.checks[0]!.output_ref!), "utf8");
      assert.match(log, /value=\[REDACTED\]/);
      assert.doesNotMatch(JSON.stringify(records(project)), /probe-secret-value|never-read/);
    } finally {
      delete process.env.PAVED_PROBE_VALUE;
    }
  });

  it("does not reuse a record once a missing requirement appears", async () => {
    const project = sandbox("env-reuse", { "project.verify.integration": { requires: { files: [".env"] } } });
    assert.equal((await runVerification({ projectRoot: project, coreRoot: ROOT })).status, "warning");
    assert.equal((await runVerification({ projectRoot: project, coreRoot: ROOT })).reused, true);
    writeFileSync(join(project, ".env"), "LOCAL=1\n");
    const rerun = await runVerification({ projectRoot: project, coreRoot: ROOT });
    assert.equal(rerun.reused, undefined);
    assert.equal(rerun.status, "success");
  });
});

describe("check dependencies", () => {
  it("runs a check after the checks it depends on", async () => {
    const project = sandbox("deps-order", {
      "project.verify.compile": { depends_on: ["project.verify.install"] },
      "project.verify.install": { file: "install.txt" },
    });
    const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
    assert.equal(result.status, "success", JSON.stringify(result.diagnostics));
    assert.deepEqual(calls(project), ["install.txt", "state.txt"]);
    assert.deepEqual(result.checks.map((check) => check.id), ["project.verify.install", "project.verify.compile"]);
  });

  it("blocks dependents of a failed check instead of running them on stale inputs", async () => {
    const project = sandbox("deps-blocked", {
      "project.verify.install": { file: "install.txt" },
      "project.verify.compile": { depends_on: ["project.verify.install"] },
      "project.verify.test": { depends_on: ["project.verify.compile"] },
    });
    writeFileSync(join(project, "install.txt"), "FAIL could not install the sibling module\n");
    const result = await cli(project, "--json");
    assert.equal(result.status, "failed");
    assert.equal(exitCode(result), 7);
    assert.deepEqual(calls(project), ["install.txt"]);
    const checks = recordedChecks(project);
    assert.deepEqual(checks.map((check) => [check.check, check.status, check.blocked_by]), [
      ["project.verify.install", "failed", undefined],
      ["project.verify.compile", "blocked", ["project.verify.install"]],
      ["project.verify.test", "blocked", ["project.verify.compile"]],
    ]);
    assert.match(checks[1]!.reason!, /project\.verify\.install is failed/);
  });

  it("rejects a dependency cycle and an unlisted dependency before running anything", async () => {
    const cyclic = sandbox("deps-cycle", {
      "project.verify.a": { depends_on: ["project.verify.b"] },
      "project.verify.b": { depends_on: ["project.verify.a"] },
    });
    const cycle = await cli(cyclic, "--json");
    assert.equal(exitCode(cycle), 4);
    assert.equal(cycle.diagnostics[0]?.code, "PAVED_VERIFY_CHECK_DEPENDENCY_CYCLE");
    assert.match(cycle.diagnostics[0]!.message, /project\.verify\.a -> project\.verify\.b -> project\.verify\.a/);
    assert.deepEqual(calls(cyclic), []);

    const dangling = sandbox("deps-unresolved", { "project.verify.a": { depends_on: ["project.verify.missing"] } });
    const unresolved = await cli(dangling, "--json");
    assert.equal(unresolved.diagnostics[0]?.code, "PAVED_VERIFY_CHECK_DEPENDENCY_UNRESOLVED");
    assert.deepEqual(calls(dangling), []);
  });
});

describe("pre-existing failures", () => {
  it("classifies a failure the base revision shares as pre-existing and reports a warning", async () => {
    const project = sandbox("pre-existing", { "project.verify.front": {} });
    repository(project, "FAIL src/app.spec.ts (1.2 s)\n");
    writeFileSync(join(project, "unrelated.txt"), "a change elsewhere\n");
    git(project, "add", "-A");
    git(project, "commit", "-qm", "unrelated");
    writeFileSync(join(project, "state.txt"), "FAIL src/app.spec.ts (3.4 s)\n");

    const result = await cli(project, "--changed", "--base", "main", "--json");

    assert.equal(result.status, "warning", JSON.stringify(result));
    assert.equal(exitCode(result), 1);
    const [check] = recordedChecks(project);
    assert.equal(check!.status, "failed");
    assert.equal(check!.pre_existing, true);
    assert.equal(check!.baseline?.status, "failed");
    assert.ok(existsSync(join(project, check!.baseline!.output_ref!)));
    assert.equal(records(project).at(-1)!.verification && (records(project).at(-1)!.verification as { base_revision?: string }).base_revision,
      git(project, "rev-parse", "main").trim());
    const data = result.data as { unproven: { id: string; reason: string; base_output_ref?: string }[]; checks: { pre_existing?: boolean }[] };
    assert.deepEqual(data.unproven.map(({ id, reason }) => [id, reason]), [["project.verify.front", "pre-existing"]]);
    assert.equal(data.checks[0]!.pre_existing, true);
    assert.ok(result.diagnostics.some((item) => item.code === "PAVED_VERIFY_PRE_EXISTING_FAILURE"));
    assert.equal(git(project, "worktree", "list").trim().split("\n").length, 1, "the base worktree is removed");
  });

  it("keeps a failure with a line the base output lacks as a failure", async () => {
    const project = sandbox("new-failure", { "project.verify.front": {} });
    repository(project, "FAIL src/app.spec.ts\n");
    writeFileSync(join(project, "state.txt"), "FAIL src/app.spec.ts\nFAIL src/new.spec.ts\n");

    const result = await cli(project, "--changed", "--base", "main", "--json");

    assert.equal(result.status, "failed");
    assert.equal(exitCode(result), 7);
    const [check] = recordedChecks(project);
    assert.equal(check!.pre_existing, undefined);
    assert.equal(check!.baseline?.status, "failed");
    const data = result.data as { checks: { excerpt?: string[]; output_ref?: string }[] };
    assert.deepEqual(data.checks[0]!.excerpt, ["FAIL src/app.spec.ts", "FAIL src/new.spec.ts"]);
    assert.match(data.checks[0]!.output_ref!, /\.log$/);
  });

  it("keeps a failure the base does not have as a failure", async () => {
    const project = sandbox("base-passes", { "project.verify.front": {} });
    repository(project, "ok\n");
    writeFileSync(join(project, "state.txt"), "FAIL src/app.spec.ts\n");

    const result = await runVerification({ projectRoot: project, coreRoot: ROOT, baseRevision: git(project, "rev-parse", "main").trim() });

    assert.equal(result.status, "failed");
    assert.equal(recordedChecks(project)[0]!.baseline?.status, "passed");
  });

  it("reuses a base outcome recorded for the same check instead of rerunning it", async () => {
    const project = sandbox("base-reuse", { "project.verify.front": {} });
    repository(project, "FAIL known\n");
    const base = git(project, "rev-parse", "main").trim();
    writeFileSync(join(project, "notes.txt"), "first\n");
    await runVerification({ projectRoot: project, coreRoot: ROOT, baseRevision: base });
    assert.equal(calls(project).length, 1, "the base run happens in its own worktree");
    writeFileSync(join(project, "notes.txt"), "second\n");

    const second = await runVerification({ projectRoot: project, coreRoot: ROOT, baseRevision: base });

    assert.equal(second.status, "warning");
    const [check] = recordedChecks(project);
    assert.equal(check!.pre_existing, true);
    assert.match(check!.baseline?.reused_from ?? "", /^verify-/);
  });
});

describe("evidence reuse", () => {
  it("reuses evidence recorded before a commit for the commit that captures the same tree", async () => {
    const project = sandbox("commit-reuse", { "project.verify.front": {} });
    repository(project, "ok\n");
    writeFileSync(join(project, "feature.txt"), "new feature\n");
    const before = await cli(project, "--changed", "--base", "main", "--json");
    assert.equal(before.status, "success", JSON.stringify(before));
    git(project, "add", "-A");
    git(project, "commit", "-qm", "feature");

    const after = await cli(project, "--changed", "--base", "main", "--json");

    assert.equal((after.data as { reused?: boolean }).reused, true);
    assert.equal(calls(project).length, 1);
  });

  it("waits for a held lock and reuses what the run holding it recorded for the same change", async () => {
    const project = sandbox("lock-wait", { "project.verify.front": {} });
    writeFileSync(join(project, "state.txt"), "FAIL broken\n");
    const release = acquireConsumerOperationLock(project, "verify");
    const waiting = runVerification({ projectRoot: project, coreRoot: ROOT, lockWaitMs: 10_000 });
    await new Promise((done) => setTimeout(done, 200));
    release();
    const holder = await runVerification({ projectRoot: project, coreRoot: ROOT });

    const waited = await waiting;

    assert.equal(holder.status, "failed");
    assert.equal(waited.status, "failed");
    assert.equal(waited.reused, true);
    assert.deepEqual(waited.evidenceFiles, holder.evidenceFiles);
    assert.equal(calls(project).length, 1, "the waiting run does not repeat the checks");
    assert.ok(waited.diagnostics.some((item) => item.code === "PAVED_VERIFY_INCOMPLETE"));
  });

  it("gives up after the wait and reports the held lock", async () => {
    const project = sandbox("lock-timeout", { "project.verify.front": {} });
    const release = acquireConsumerOperationLock(project, "verify");
    try {
      const result = await cli(project, "--lock-wait", "1", "--json");
      assert.equal(result.diagnostics[0]?.code, "PAVED_OPERATION_IN_PROGRESS");
      assert.equal(exitCode(result), 8);
    } finally {
      release();
    }
  });
});

describe("check output capture", () => {
  it("keeps the end of a long output, where failure summaries are printed", async () => {
    const project = sandbox("long-output", { "project.verify.front": {} });
    writeFileSync(join(project, "big.txt"), "");
    writeFileSync(join(project, "state.txt"), "FAIL at the very end\n");
    const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
    const log = readFileSync(join(project, result.checks[0]!.output_ref!), "utf8");
    assert.match(log, /bytes omitted/);
    assert.match(log, /FAIL at the very end/);
    assert.deepEqual(result.checks[0]!.excerpt, ["FAIL at the very end"]);
  });
});
