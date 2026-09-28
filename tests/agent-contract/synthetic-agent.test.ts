import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(root, "cli/index.ts");
let counter = 0;

type Result = {
  command: string;
  status: "success" | "warning" | "failed";
  data?: Record<string, unknown>;
  diagnostics: { category: string; code: string; severity: string }[];
};

function consumer(): string {
  const path = join("/tmp", `paved-agent-contract-${process.pid}-${counter++}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "# Synthetic consumer\n");
  return path;
}

function invoke(project: string, ...args: string[]): { result: Result; exitCode: number } {
  const processResult = spawnSync(process.execPath, [cli, ...args, "--project", project, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(processResult.error, undefined, processResult.stderr);
  return { result: JSON.parse(processResult.stdout) as Result, exitCode: processResult.status ?? -1 };
}

describe("synthetic agent black-box contract", () => {
  it("discovers, initializes, loads context, and reads lifecycle through public CLI output", () => {
    const project = consumer();
    try {
      const version = JSON.parse(execFileSync(process.execPath, [cli, "--version", "--json"], { cwd: root, encoding: "utf8" })) as {
        status: string;
        data: { version: string };
      };
      assert.equal(version.status, "success");
      assert.match(version.data.version, /^\d+\.\d+\.\d+$/);

      const before = invoke(project, "status");
      assert.equal(before.result.data?.lifecycleState, "UNINITIALIZED");
      assert.equal(before.result.diagnostics[0]?.category, "config");
      assert.equal(before.exitCode, 4);

      const init = invoke(project, "init", "--no-generate");
      assert.equal(init.result.status, "success");
      assert.equal(init.result.data?.initialized, true);

      const generated = invoke(project, "generate");
      assert.ok(["success", "warning"].includes(generated.result.status));
      assert.equal(existsSync(join(project, ".paved/project/architecture/overview.md")), true);

      const after = invoke(project, "status");
      assert.ok(["GENERATED", "VALIDATED", "READY"].includes(String(after.result.data?.lifecycleState)));
      assert.equal(typeof after.result.data?.lockHealth, "string");
      assert.equal(Array.isArray(after.result.data?.selectedAdapters), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("exposes diagnostics and contract-only capability limits without pretending availability", () => {
    const project = consumer();
    try {
      const doctor = invoke(project, "doctor");
      assert.equal(doctor.result.status, "failed");
      assert.ok(doctor.result.diagnostics.some((diagnostic) => diagnostic.code === "PAVED_CONSUMER_UNINITIALIZED"));

      const unsupported = invoke(project, "tool");
      assert.equal(unsupported.exitCode, 2);
      assert.equal(unsupported.result.diagnostics[0]?.category, "usage");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
