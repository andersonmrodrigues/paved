import assert from "node:assert/strict";
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
