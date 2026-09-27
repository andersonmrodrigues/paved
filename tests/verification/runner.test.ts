import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { runVerification } from "../../cli/lib/verification-runner.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { exitCode, primaryCategory, type CommandResult } from "../../cli/result.ts";
import { schemas } from "../helpers.ts";

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
        assert.throws(() => process.kill(checkPid!, 0), { code: "ESRCH" });
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
