import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { runVerification, signalProcessGroup, verificationEnvironment } from "../../cli/lib/verification-runner.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { exitCode, primaryCategory, type CommandResult } from "../../cli/result.ts";
import { schemas } from "../helpers.ts";
import { doneTask, startTask } from "../../cli/lib/task-handoff.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE = join(ROOT, "tests/cli/fixtures/verification");
let sandboxCounter = 0;

function sandbox(name: string): string {
  const dir = join(ROOT, "tests/verification/.sandbox-runner", `${name}-${process.pid}-${++sandboxCounter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  chmodSync(join(dir, ".paved/tools/marker.mjs"), 0o755);
  chmodSync(join(dir, ".paved/tools/unlisted.mjs"), 0o755);
  return dir;
}

function markerPath(project: string): string {
  return join(project, ".paved/generated/evidence/marker-called.txt");
}

function unlistedPath(project: string): string {
  return join(project, ".paved/generated/evidence/unlisted-called.txt");
}

function evidenceFiles(project: string): string[] {
  const dir = join(project, ".paved/generated/evidence");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSyncSafe(current)) {
      const full = join(current, entry);
      if (statIsDirectory(full)) walk(full);
      else if (entry.endsWith(".yaml")) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function statIsDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}

function writeProfile(project: string, checks: string[]): void {
  writeFileSync(join(project, ".paved/verification/profile.yaml"), stringify({
    apiVersion: "paved/v1",
    kind: "VerificationProfile",
    checks,
    policy: { minimum_recorder: "agent" },
  }));
}

function writeMarkerToolOutput(project: string, format: "text" | "json" | "yaml" | "none"): void {
  const path = join(project, ".paved/tools/marker.yaml");
  const tool = parse(readFileSync(path, "utf8")) as { outputs: { format: string; fields?: string[] } };
  tool.outputs.format = format;
  if (format === "json" || format === "yaml") tool.outputs.fields = ["ok"];
  else delete tool.outputs.fields;
  writeFileSync(path, stringify(tool));
}

function writeMarkerMode(project: string, mode: string): void {
  const path = join(project, ".paved/verification/checks/marker.yaml");
  const check = parse(readFileSync(path, "utf8")) as { inputs: Record<string, unknown> };
  check.inputs.mode = mode;
  delete check.inputs.secret;
  writeFileSync(path, stringify(check));
}

function readEvidence(project: string): Record<string, unknown> {
  const files = evidenceFiles(project);
  assert.equal(files.length, 1, `expected one evidence file, got ${files.map((file) => relative(project, file)).join(", ")}`);
  const record = parse(readFileSync(files[0]!, "utf8")) as Record<string, unknown>;
  const validation = schemas().validate(record);
  assert.ok(validation.valid, validation.errors.join("\n"));
  return record;
}

function resultText(result: unknown): string {
  return JSON.stringify(result);
}

async function runCli(projectRoot: string, extra: readonly string[] = []): Promise<CommandResult> {
  return dispatchCli({
    argv: ["verify", "--project", projectRoot, ...extra],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });
}

describe("verification runner", () => {
  it("attaches actual verification evidence to an explicitly selected task", async () => {
    const project = sandbox("task-evidence");
    try {
      const task = startTask(project, "work", "Make a change");
      const result = await runCli(project, ["--task", "work"]);
      assert.equal(result.status, "success", JSON.stringify(result));
      const evidence = (result.data as { evidence: string[] }).evidence;
      assert.ok(evidence.length > 0);
      const content = readFileSync(task.path, "utf8");
      assert.match(content, /## Evidence\n[\s\S]*Verification success:[\s\S]*## Next step/);
      for (const path of evidence) assert.ok(content.includes(path));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not run checks when the selected task is missing", async () => {
    const project = sandbox("task-missing");
    try {
      const result = await runCli(project, ["--task", "missing"]);
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_VERIFY_TASK_INVALID");
      assert.equal(existsSync(markerPath(project)), false);
      assert.equal(evidenceFiles(project).length, 0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("records failed verification as failed in the task", async () => {
    const project = sandbox("task-failed-evidence");
    try {
      const task = startTask(project, "work", "Make a change");
      writeProfile(project, ["project.verify.failure"]);
      const result = await runCli(project, ["--task", "work"]);
      assert.equal(result.status, "failed");
      const evidence = (result.data as { evidence: string[] }).evidence;
      assert.ok(evidence.length > 0);
      const content = readFileSync(task.path, "utf8");
      assert.match(content, /## Evidence\n[\s\S]*Verification failed:/);
      assert.ok(content.includes(evidence[0]!));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not run checks for a completed task", async () => {
    const project = sandbox("task-done");
    try {
      startTask(project, "work", "Make a change");
      doneTask(project, "work", "Finished");
      const result = await runCli(project, ["--task", "work"]);
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_VERIFY_TASK_INVALID");
      assert.equal(existsSync(markerPath(project)), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("returns failure and preserves evidence when attaching it to a locked task fails", async () => {
    const project = sandbox("task-locked");
    try {
      const task = startTask(project, "work", "Make a change");
      mkdirSync(`${task.path}.lock`);
      const result = await runCli(project, ["--task", "work"]);
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics.at(-1)?.code, "PAVED_VERIFY_TASK_EVIDENCE_FAILED");
      const evidence = (result.data as { evidence: string[] }).evidence;
      assert.ok(evidence.length > 0);
      assert.ok(existsSync(join(project, evidence[0]!)));
      assert.equal(readFileSync(task.path, "utf8"), task.content);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("runs checks selected by untracked changes with verify --changed", async () => {
    const project = sandbox("changed-untracked");
    try {
      execFileSync("git", ["init", "-q", project]);
      const path = join(project, ".paved/verification/checks/marker.yaml");
      const check = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"] }));
      writeFileSync(join(project, ".paved/verification/checks/docs.yaml"), stringify({
        ...check, id: "project.verify.docs", applies_to: ["docs/**"],
      }));
      writeProfile(project, ["project.verify.marker", "project.verify.docs"]);
      execFileSync("git", ["-C", project, "add", "-f", ".paved"]);
      execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]);
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "src", "main.js"), "export const value = 1;\n");

      const result = await runCli(project, ["--changed"]);

      assert.equal(result.status, "success", JSON.stringify(result));
      assert.equal(existsSync(markerPath(project)), true);
      assert.equal(evidenceFiles(project).length, 1);
      assert.deepEqual((result.data as { checks: { id: string; status: string }[] }).checks.map(({ id, status }) => [id, status]),
        [["project.verify.marker", "passed"], ["project.verify.docs", "skipped"]]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("runs all checks when verification configuration changes", async () => {
    const project = sandbox("changed-configuration");
    try {
      execFileSync("git", ["init", "-q", project]);
      const path = join(project, ".paved/verification/checks/marker.yaml");
      const check = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"] }));
      execFileSync("git", ["-C", project, "add", "-f", ".paved"]);
      execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]);
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"], purpose: "Updated verification." }));

      const result = await runCli(project, ["--changed"]);

      assert.equal(result.status, "success", JSON.stringify(result));
      assert.equal(existsSync(markerPath(project)), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("includes committed branch changes when given a base", async () => {
    const project = sandbox("changed-branch");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", project]);
      const path = join(project, ".paved/verification/checks/marker.yaml");
      const check = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"] }));
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "src/main.js"), "export const value = 1;\n");
      execFileSync("git", ["-C", project, "add", "-f", ".paved", "src"]);
      execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]);
      execFileSync("git", ["-C", project, "checkout", "-qb", "feature"]);
      writeFileSync(join(project, "src/main.js"), "export const value = 2;\n");
      execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qam", "change"]);

      const result = await runCli(project, ["--changed", "--base", "main"]);

      assert.equal(result.status, "success", JSON.stringify(result));
      assert.equal(existsSync(markerPath(project)), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("fails closed when the changed-file scope cannot be determined", async () => {
    const project = mkdtempSync(join(tmpdir(), "paved-changed-nongit-"));
    try {
      cpSync(FIXTURE, project, { recursive: true });

      const result = await runCli(project, ["--changed"]);

      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_VERIFY_CHANGE_SCOPE_UNAVAILABLE");
      assert.equal(existsSync(markerPath(project)), false);
      assert.deepEqual(evidenceFiles(project), []);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("uses project-relative change paths inside a larger Git repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "paved-nested-git-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const project = join(root, "nested");
      cpSync(FIXTURE, project, { recursive: true });
      chmodSync(join(project, ".paved/tools/marker.mjs"), 0o755);
      const path = join(project, ".paved/verification/checks/marker.yaml");
      const check = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"] }));
      execFileSync("git", ["-C", root, "add", "-f", "nested/.paved"]);
      execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline"]);
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "src/main.js"), "export const value = 1;\n");

      const result = await runCli(project, ["--changed"]);

      assert.equal(result.status, "success", JSON.stringify(result));
      assert.equal(existsSync(markerPath(project)), true);
      rmSync(join(project, "src/main.js"));
      rmSync(markerPath(project));
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"], purpose: "Changed configuration." }));

      const afterConfigChange = await runCli(project, ["--changed"]);

      assert.equal(afterConfigChange.status, "success", JSON.stringify(afterConfigChange));
      assert.equal(existsSync(markerPath(project)), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a missing profile and never scans or runs unlisted scripts", async () => {
    const project = sandbox("missing-profile");
    try {
      rmSync(join(project, ".paved/verification/profile.yaml"));

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });

      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_VERIFY_PROFILE_MISSING");
      assert.equal(existsSync(markerPath(project)), false);
      assert.equal(existsSync(unlistedPath(project)), false);
      assert.deepEqual(evidenceFiles(project), []);
      assert.equal(existsSync(join(project, ".paved-operation-lock")), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("rejects an empty profile without producing a false passing evidence record", async () => {
    const project = sandbox("empty-profile");
    try {
      writeProfile(project, []);

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });

      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_VERIFY_NO_CHECKS");
      assert.equal(existsSync(markerPath(project)), false);
      assert.deepEqual(evidenceFiles(project), []);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("runs only the explicitly configured approved binding without a shell and stores valid evidence", async () => {
    const project = sandbox("valid-check");
    try {
      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });

      assert.equal(result.status, "success");
      assert.equal(existsSync(markerPath(project)), true);
      assert.equal(existsSync(unlistedPath(project)), false);
      assert.match(readFileSync(markerPath(project), "utf8"), /literal:\$PAVED_VERIFY_SECRET;touch should-not-exist/);
      assert.equal(existsSync(join(project, "should-not-exist")), false);

      const record = readEvidence(project);
      assert.equal((record.completion as { status?: unknown }).status, "complete");
      assert.equal((record.completion as { verification?: unknown }).verification, "verified");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reuses a verified record for an unchanged tree and configuration instead of rerunning", async () => {
    const project = sandbox("reuse-unchanged");
    try {
      const first = await runVerification({ projectRoot: project, coreRoot: ROOT });
      assert.equal(first.status, "success");
      assert.equal(first.reused, undefined);
      rmSync(markerPath(project));

      const second = await runVerification({ projectRoot: project, coreRoot: ROOT });
      assert.equal(second.status, "success");
      assert.equal(second.reused, true);
      assert.deepEqual(second.evidenceFiles, first.evidenceFiles);
      assert.equal(second.evaluation?.verification, "verified");
      assert.equal(existsSync(markerPath(project)), false, "a reused result must not run the Check again");
      const record = readEvidence(project);
      assert.match(String((record.verification as { configuration_sha256?: unknown }).configuration_sha256), /^[a-f0-9]{64}$/);

      const cli = await runCli(project);
      assert.equal((cli.data as { reused?: unknown }).reused, true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("runs again when the tree, the Check configuration or the Checks the scope selects differ", async () => {
    const project = sandbox("reuse-invalidated");
    try {
      const marker = parse(readFileSync(join(project, ".paved/verification/checks/marker.yaml"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(project, ".paved/verification/checks/docs.yaml"), stringify({ ...marker, id: "project.verify.docs", applies_to: ["docs/**"] }));
      writeProfile(project, ["project.verify.marker", "project.verify.docs"]);
      assert.equal((await runVerification({ projectRoot: project, coreRoot: ROOT })).status, "success");

      writeFileSync(join(project, "changed.txt"), "new content\n");
      const changedTree = await runVerification({ projectRoot: project, coreRoot: ROOT });
      assert.equal(changedTree.reused, undefined);

      writeMarkerMode(project, "json");
      const changedCheck = await runVerification({ projectRoot: project, coreRoot: ROOT });
      assert.equal(changedCheck.reused, undefined);

      const scoped = await runVerification({ projectRoot: project, coreRoot: ROOT, changedFiles: ["changed.txt"] });
      assert.equal(scoped.reused, undefined);
      assert.equal(evidenceFiles(project).length, 4);

      // A different scope that selects the same Checks proves the same thing.
      const sameSelection = await runVerification({ projectRoot: project, coreRoot: ROOT, changedFiles: ["changed.txt", "other.txt"] });
      assert.equal(sameSelection.reused, true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports only a recorded result with --recorded and never runs a Check", async () => {
    const project = sandbox("recorded-only");
    try {
      const missing = await runCli(project, ["--recorded"]);
      assert.equal(missing.status, "failed");
      assert.equal(exitCode(missing), 7);
      assert.ok(missing.diagnostics.some((item) => item.code === "PAVED_VERIFY_NOT_RECORDED"), resultText(missing));
      assert.equal(existsSync(markerPath(project)), false, "--recorded must not run a Check");
      assert.equal(evidenceFiles(project).length, 0);

      assert.equal((await runVerification({ projectRoot: project, coreRoot: ROOT })).status, "success");
      rmSync(markerPath(project));
      const recorded = await runCli(project, ["--recorded"]);
      assert.equal(recorded.status, "success", resultText(recorded));
      assert.equal((recorded.data as { reused?: unknown }).reused, true);
      assert.equal(existsSync(markerPath(project)), false);

      writeMarkerMode(project, "fail");
      assert.equal((await runVerification({ projectRoot: project, coreRoot: ROOT })).status, "failed");
      rmSync(markerPath(project));
      const failed = await runVerification({ projectRoot: project, coreRoot: ROOT, recordedOnly: true });
      assert.equal(failed.status, "failed");
      assert.equal(failed.reused, true, "the newest failing record is reported, not hidden");
      assert.ok(failed.checks.some((check) => check.status === "failed"));
      assert.equal(existsSync(markerPath(project)), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("records a change no Check applies to under --recorded, since nothing runs", async () => {
    const project = sandbox("recorded-irrelevant");
    try {
      const path = join(project, ".paved/verification/checks/marker.yaml");
      const check = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, stringify({ ...check, applies_to: ["src/**"] }));
      const result = await runVerification({ projectRoot: project, coreRoot: ROOT, changedFiles: ["docs/readme.md"], recordedOnly: true });
      assert.ok(!result.diagnostics.some((item) => item.code === "PAVED_VERIFY_NOT_RECORDED"), resultText(result));
      assert.equal(existsSync(markerPath(project)), false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("never reuses an earlier pass when the newest record for the same change is not verified", async () => {
    const project = sandbox("reuse-newest-decides");
    try {
      const first = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const file = first.evidenceFiles[0]!;
      const record = parse(readFileSync(file, "utf8")) as { id: string; completion: { status: string; verification: string } };
      record.id = "verify-9999-12-31t23-59-59-999z-1-1";
      record.completion.status = "incomplete";
      record.completion.verification = "unverified";
      writeFileSync(join(project, ".paved/generated/evidence", `${record.id}.yaml`), stringify(record));
      rmSync(markerPath(project));

      const rerun = await runVerification({ projectRoot: project, coreRoot: ROOT });
      assert.equal(rerun.reused, undefined);
      assert.equal(existsSync(markerPath(project)), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps evidence ids and output logs unique when configured checks share a final id segment", async () => {
    const project = sandbox("duplicate-check-suffix");
    try {
      const first = parse(readFileSync(join(project, ".paved/verification/checks/marker.yaml"), "utf8")) as Record<string, unknown>;
      writeFileSync(join(project, ".paved/verification/checks/other-marker.yaml"), stringify({ ...first, id: "project.other.marker" }));
      writeProfile(project, ["project.verify.marker", "project.other.marker"]);

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const record = readEvidence(project);
      const checks = record.checks as { id: string; output_ref?: string }[];
      const logs = checks.map((check) => check.output_ref);
      const artifacts = record.artifacts as { source: { location: string; sha256: string } }[];

      assert.equal(result.status, "success", resultText(result));
      assert.equal(new Set(checks.map((check) => check.id)).size, 2);
      assert.equal(new Set(logs).size, 2);
      for (const log of logs) {
        const file = join(project, log!);
        assert.equal(existsSync(file), true);
        const artifact = artifacts.find((entry) => entry.source.location === log);
        assert.ok(artifact);
        assert.equal(artifact.source.sha256, createHash("sha256").update(readFileSync(file)).digest("hex"));
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports malformed YAML in verification content roots as configuration errors", async () => {
    const project = sandbox("malformed-check-content");
    try {
      writeFileSync(join(project, ".paved/verification/checks/empty.yaml"), "");
      writeProfile(project, ["project.verify.marker", "project.verify.failure"]);

      const result = await runCli(project);

      assert.equal(exitCode(result), 4);
      assert.equal(primaryCategory(result), "config");
      assert.equal(result.diagnostics.filter((item) => item.code === "PAVED_VERIFY_CHECK_INVALID").length, 1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  for (const [signal, expectedExitCode] of [["SIGINT", 130], ["SIGHUP", 129]] as const) {
    it(`forwards ${signal} to detached check processes after an earlier launch failure`, { skip: process.platform === "win32" }, async () => {
      const project = sandbox(`interrupt-child-${signal.toLowerCase()}`);
      const pidPath = join(project, ".paved/generated/evidence/check-pid.txt");
      let cli: ReturnType<typeof spawn> | undefined;
      let checkPid: number | undefined;
      try {
        writeMarkerMode(project, "timeout");
        writeFileSync(join(project, ".paved/tools/marker.mjs"), [
          "#!/usr/bin/env node",
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'import { dirname } from "node:path";',
          `const pidFile = ${JSON.stringify(pidPath)};`,
          "mkdirSync(dirname(pidFile), { recursive: true });",
          "writeFileSync(pidFile, String(process.pid));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"), { mode: 0o755 });
        const checkPath = join(project, ".paved/verification/checks/marker.yaml");
        const check = parse(readFileSync(checkPath, "utf8")) as { timeout_seconds?: number };
        check.timeout_seconds = 60;
        writeFileSync(checkPath, stringify(check));
        writeProfile(project, ["project.verify.missing-executable", "project.verify.marker"]);
        cli = spawn(process.execPath, [join(ROOT, "cli/index.ts"), "verify", "--project", project], {
          cwd: ROOT,
          stdio: "ignore",
        });
        for (let attempt = 0; attempt < 300 && !existsSync(pidPath) && cli.exitCode === null; attempt += 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        assert.equal(existsSync(pidPath), true, "verification child did not start");
        checkPid = Number(readFileSync(pidPath, "utf8"));
        const closed = once(cli, "close") as Promise<[number | null, NodeJS.Signals | null]>;

        assert.equal(cli.kill(signal), true);
        const [code, childSignal] = await closed;

        assert.equal(childSignal, null);
        assert.equal(code, expectedExitCode);
        // The killed check is orphaned when the CLI exits and stays visible until init reaps it.
        const checkGone = () => {
          try {
            process.kill(checkPid!, 0);
            return false;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
            throw error;
          }
        };
        for (let attempt = 0; attempt < 200 && !checkGone(); attempt += 1) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        assert.equal(checkGone(), true, "verification child is still running");
      } finally {
        if (cli !== undefined && cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
        if (checkPid !== undefined) {
          try {
            process.kill(checkPid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
        rmSync(project, { recursive: true, force: true });
      }
    });
  }

  it("enforces check timeouts when descendants inherit the command output pipes", async () => {
    const project = sandbox("timeout-descendant");
    try {
      writeProfile(project, ["project.verify.marker"]);
      writeMarkerMode(project, "timeout");
      writeFileSync(join(project, ".paved/tools/marker.mjs"), [
        "#!/usr/bin/env node",
        'import { spawn } from "node:child_process";',
        'spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "inherit" });',
        "setTimeout(() => {}, 10000);",
        "",
      ].join("\n"));
      const checkPath = join(project, ".paved/verification/checks/marker.yaml");
      const check = parse(readFileSync(checkPath, "utf8")) as { timeout_seconds?: number };
      check.timeout_seconds = 1;
      writeFileSync(checkPath, stringify(check));
      const started = Date.now();

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const elapsed = Date.now() - started;

      assert.equal(result.status, "failed");
      assert.ok(elapsed < 3_000, `verification took ${elapsed}ms despite a 1s check timeout`);
      assert.equal((readEvidence(project).checks as [{ status: string }])[0]!.status, "error");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("retains failed and timed-out outcomes in evidence", async () => {
    const failed = sandbox("failed-check");
    const timeout = sandbox("timeout-check");
    try {
      writeProfile(failed, ["project.verify.failure"]);
      writeProfile(timeout, ["project.verify.timeout"]);

      const failedResult = await runVerification({ projectRoot: failed, coreRoot: ROOT });
      const timeoutResult = await runVerification({ projectRoot: timeout, coreRoot: ROOT });

      assert.equal(failedResult.status, "failed");
      assert.equal(timeoutResult.status, "failed");
      assert.equal((readEvidence(failed).checks as [{ status: string }])[0]!.status, "failed");
      assert.equal((readEvidence(timeout).checks as [{ status: string }])[0]!.status, "error");
    } finally {
      rmSync(failed, { recursive: true, force: true });
      rmSync(timeout, { recursive: true, force: true });
    }
  });

  it("blocks sensitive command-bound inputs before spawning and scrubs the supplied value", async () => {
    const project = sandbox("secret-argv-block");
    const secret = "PAVED-ARGV-SENTINEL";
    try {
      const check = parse(readFileSync(join(project, ".paved/verification/checks/marker.yaml"), "utf8")) as { inputs: Record<string, string> };
      check.inputs.secret = secret;
      writeFileSync(join(project, ".paved/verification/checks/marker.yaml"), stringify(check));

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const evidenceRoot = join(project, ".paved/generated/evidence");
      const allGenerated = readAllFiles(evidenceRoot).join("\n");

      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics.some((item) => item.code === "PAVED_VERIFY_SENSITIVE_ARGV_INPUT"), true);
      assert.equal(existsSync(markerPath(project)), false);
      assert.equal(resultText(result).includes(secret), false);
      assert.equal(allGenerated.includes(secret), false);
      assert.equal(resultText(result).includes("--secret"), false);
      assert.equal((readEvidence(project).checks as [{ status: string; reason?: string }])[0]!.status, "blocked");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("parses stdout according to Tool output formats without mixing stderr into the result", async () => {
    for (const [format, mode] of [
      ["text", "pass"],
      ["json", "json"],
      ["yaml", "yaml"],
      ["none", "none"],
    ] as const) {
      const project = sandbox(`output-${format}`);
      try {
        writeMarkerToolOutput(project, format);
        writeMarkerMode(project, mode);

        const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
        const generated = readAllFiles(join(project, ".paved/generated/evidence")).join("\n");

        assert.equal(result.status, "success", `${format}: ${resultText(result)}`);
        assert.equal((readEvidence(project).checks as [{ status: string }])[0]!.status, "passed", format);
        assert.match(generated, /stderr/, format);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    }
  });

  it("reports malformed structured stdout as a failed check without leaking raw output", async () => {
    for (const [format, mode] of [
      ["json", "malformed-json"],
      ["yaml", "malformed-yaml"],
    ] as const) {
      const project = sandbox(`malformed-${format}`);
      try {
        writeMarkerToolOutput(project, format);
        writeMarkerMode(project, mode);

        const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
        const generated = readAllFiles(join(project, ".paved/generated/evidence")).join("\n");

        assert.equal(result.status, "failed");
        assert.equal(result.diagnostics.some((item) => item.code === "PAVED_VERIFY_OUTPUT_MALFORMED"), true);
        assert.equal((readEvidence(project).checks as [{ status: string; summary?: string }])[0]!.status, "failed");
        assert.equal(resultText(result).includes("PAVED-MALFORMED-SENTINEL"), false);
        assert.equal(generated.includes("PAVED-MALFORMED-SENTINEL"), false);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    }
  });

  it("scrubs secret-like keys from structured stdout logs", async () => {
    for (const [format, mode] of [
      ["json", "json-secret"],
      ["yaml", "yaml-secret"],
    ] as const) {
      const project = sandbox(`structured-secret-${format}`);
      try {
        writeMarkerToolOutput(project, format);
        writeMarkerMode(project, mode);

        const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
        const generated = readAllFiles(join(project, ".paved/generated/evidence")).join("\n");

        assert.equal(result.status, "success", resultText(result));
        assert.equal(generated.includes("PAVED-STRUCTURED-SENTINEL"), false);
        assert.match(generated, /\[REDACTED\]/);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    }
  });

  it("scrubs compound secret keys from persisted stderr logs", async () => {
    const project = sandbox("compound-stderr");
    try {
      writeMarkerMode(project, "compound-stderr");

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const generated = readAllFiles(join(project, ".paved/generated/evidence")).join("\n");

      assert.equal(result.status, "success", resultText(result));
      assert.equal(generated.includes("PAVED-STDERR-ACCESS"), false);
      assert.equal(generated.includes("PAVED-STDERR-CLIENT"), false);
      assert.equal(generated.includes("PAVED-STDERR-REFRESH"), false);
      assert.match(generated, /access_token=\[REDACTED\]/);
      assert.match(generated, /client_secret: \[REDACTED\]/);
      assert.match(generated, /"refresh-token":"\[REDACTED\]"/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("scrubs camelCase and non-string secret values from persisted JSON output", async () => {
    const project = sandbox("camel-secret-json");
    try {
      writeMarkerToolOutput(project, "json");
      writeMarkerMode(project, "camel-secret");

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const generated = readAllFiles(join(project, ".paved/generated/evidence")).join("\n");

      assert.equal(result.status, "success", resultText(result));
      assert.doesNotMatch(generated, /PAVED-CAMEL-(?:ACCESS|NESTED)|123456/);
      assert.match(generated, /"accessToken":"\[REDACTED\]"/);
      assert.match(generated, /"clientSecret":"\[REDACTED\]"/);
      assert.match(generated, /"sessionToken":"\[REDACTED\]"/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("blocks invalid documents, unresolved bindings, unsafe authorization, and launch failures without echoing argv", async () => {
    const invalidProfile = sandbox("invalid-profile");
    const invalid = sandbox("invalid-check");
    const invalidTool = sandbox("invalid-tool");
    const invalidImplementation = sandbox("invalid-implementation");
    const missingTool = sandbox("missing-tool");
    const unauthorized = sandbox("unauthorized");
    const missingExecutable = sandbox("missing-executable");
    try {
      writeFileSync(join(invalidProfile, ".paved/verification/profile.yaml"), "apiVersion: paved/v1\nkind: VerificationProfile\nchecks: bad\n");
      writeFileSync(join(invalid, ".paved/verification/checks/marker.yaml"), "apiVersion: paved/v1\nkind: Check\nid: project.verify.marker\n");
      writeFileSync(join(invalidTool, ".paved/tools/marker.yaml"), "apiVersion: paved/v1\nkind: Tool\nid: project.tool.marker\n");
      writeFileSync(join(invalidImplementation, ".paved/tool-implementations/marker.yaml"), "apiVersion: paved/v1\nkind: ToolImplementation\nid: project.tool.marker\ntool: project.tool.marker\n");
      writeProfile(missingTool, ["project.verify.missing-tool"]);
      writeProfile(unauthorized, ["project.verify.unauthorized"]);
      writeProfile(missingExecutable, ["project.verify.missing-executable"]);

      const invalidProfileResult = await runVerification({ projectRoot: invalidProfile, coreRoot: ROOT });
      const invalidResult = await runVerification({ projectRoot: invalid, coreRoot: ROOT });
      const invalidToolResult = await runVerification({ projectRoot: invalidTool, coreRoot: ROOT });
      const invalidImplementationResult = await runVerification({ projectRoot: invalidImplementation, coreRoot: ROOT });
      const missingToolResult = await runVerification({ projectRoot: missingTool, coreRoot: ROOT });
      const unauthorizedResult = await runVerification({ projectRoot: unauthorized, coreRoot: ROOT });
      const launchResult = await runVerification({ projectRoot: missingExecutable, coreRoot: ROOT });

      assert.equal(invalidProfileResult.diagnostics[0]?.category, "config");
      assert.equal(invalidResult.diagnostics[0]?.category, "config");
      assert.equal(invalidToolResult.diagnostics[0]?.category, "config");
      assert.equal(invalidImplementationResult.diagnostics[0]?.category, "config");
      assert.equal(missingToolResult.diagnostics[0]?.category, "verification");
      assert.equal(unauthorizedResult.diagnostics[0]?.category, "verification");
      assert.equal(launchResult.diagnostics[0]?.category, "environment");
      assert.equal(resultText(launchResult).includes("--secret"), false);
      assert.equal(resultText(launchResult).includes("PAVED_VERIFY_SECRET"), false);
      assert.equal(existsSync(markerPath(invalid)), false);
      assert.equal(existsSync(markerPath(missingTool)), false);
      assert.equal(existsSync(markerPath(unauthorized)), false);
    } finally {
      rmSync(invalidProfile, { recursive: true, force: true });
      rmSync(invalid, { recursive: true, force: true });
      rmSync(invalidTool, { recursive: true, force: true });
      rmSync(invalidImplementation, { recursive: true, force: true });
      rmSync(missingTool, { recursive: true, force: true });
      rmSync(unauthorized, { recursive: true, force: true });
      rmSync(missingExecutable, { recursive: true, force: true });
    }
  });
});

describe("verification process boundaries", () => {
  it("does not pass arbitrary caller environment variables to configured executables", async () => {
    const project = sandbox("environment-isolation");
    const executable = join(project, ".paved/tools/marker.mjs");
    const sentinelName = "PAVED_TEST_PRIVATE_SENTINEL";
    const sentinelValue = "do-not-forward-this";
    const previousValue = process.env[sentinelName];
    try {
      writeFileSync(executable, "#!/usr/bin/env node\nconsole.log(process.env.PAVED_TEST_PRIVATE_SENTINEL ?? \"unset\");\n");
      process.env[sentinelName] = sentinelValue;

      const result = await runVerification({ projectRoot: project, coreRoot: ROOT });
      const output = readdirSync(join(project, ".paved/generated/evidence"))
        .map(file => readFileSync(join(project, ".paved/generated/evidence", file), "utf8"))
        .join("\n");

      assert.equal(result.status, "success", resultText(result));
      assert.match(output, /unset/);
      assert.doesNotMatch(output, new RegExp(sentinelValue));
    } finally {
      if (previousValue === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previousValue;
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("refuses to write verification evidence through a symlinked output directory", async () => {
    const project = sandbox("symlinked-evidence");
    const outside = join(ROOT, "tests/verification/.sandbox-runner", `outside-${process.pid}-${++sandboxCounter}`);
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    try {
      writeFileSync(join(project, ".paved/tools/marker.mjs"), "#!/usr/bin/env node\nconsole.log(\"verified\");\n");
      mkdirSync(join(project, ".paved/generated"), { recursive: true });
      symlinkSync(outside, join(project, ".paved/generated/evidence"));

      await assert.rejects(
        runVerification({ projectRoot: project, coreRoot: ROOT }),
        /symbolic link/i,
      );

      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("verify command", () => {
  it("maps verification outcomes to the structured CLI result and rejects dry-run", async () => {
    const project = sandbox("cli-verify");
    try {
      const ok = await runCli(project);
      assert.equal(exitCode(ok), 0);

      writeProfile(project, ["project.verify.failure"]);
      const failed = await runCli(project);
      const dryRun = await runCli(project, ["--dry-run"]);

      assert.equal(primaryCategory(failed), "verification");
      assert.equal(exitCode(failed), 7);
      assert.equal(primaryCategory(dryRun), "usage");
      assert.equal(exitCode(dryRun), 2);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

function readAllFiles(root: string): string[] {
  const output: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSyncSafe(dir)) {
      const full = join(dir, entry);
      if (statIsDirectory(full)) {
        walk(full);
      } else {
        output.push(readFileSync(full, "utf8"));
      }
    }
  }
  walk(root);
  return output;
}

describe("process group signalling", () => {
  it("treats an exited but unreaped process group as gone", { skip: process.platform === "win32" }, async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      assert.equal(signalProcessGroup(child, "SIGINT"), true);
      // Block the event loop so the dead child stays unreaped when it is signalled again,
      // the same window a verification run hits when it forwards a signal and then SIGKILL.
      const until = Date.now() + 200;
      while (Date.now() < until);
      assert.doesNotThrow(() => signalProcessGroup(child, "SIGKILL"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
});

describe("verification environment", () => {
  it("forwards the selected toolchain and forces a non-interactive run, but no credentials", () => {
    const env = verificationEnvironment({
      PATH: "/bin", HOME: "/home/u", JAVA_HOME: "/jdk17", CI: "false",
      GITHUB_TOKEN: "t", NPM_TOKEN: "n", AWS_SECRET_ACCESS_KEY: "s",
    });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/u", JAVA_HOME: "/jdk17", CI: "true" });
  });
});
