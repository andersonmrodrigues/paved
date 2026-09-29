import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("runtime package artifact", () => {
  it("contains the runtime entrypoint and contracts without development tests", () => {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(packed.error, undefined, packed.stderr);
    assert.equal(packed.status, 0, packed.stderr);
    const [artifact] = JSON.parse(packed.stdout) as {
      integrity: string;
      filename: string;
      files: { path: string }[];
    }[];
    assert.ok(artifact);
    assert.match(artifact.filename, /^paved-core-\d+\.\d+\.\d+\.tgz$/);
    assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const paths = new Set(artifact.files.map((file) => file.path));
    for (const path of [
      "package.json",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "VERSION",
      "manifest.yaml",
      "cli/index.ts",
      "cli/build/cli/index.js",
      "schemas/lock.schema.yaml",
      "core/workflows/feature/workflow.yaml",
      "generators/project-context/architecture/generator.yaml",
      "integrations/shared/commands.ts",
      "adapters/technology/java/adapter.yaml",
    ]) assert.ok(paths.has(path), `package artifact is missing ${path}`);
    const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      bin: { paved: string };
      engines: { node: string };
      version: string;
    };
    assert.equal(packageMetadata.bin.paved, "./cli/build/cli/index.js");
    assert.equal(packageMetadata.engines.node, ">=22.18.0");
    const cli = spawnSync(process.execPath, ["./cli/build/cli/index.js", "--version", "--json"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(cli.error, undefined, cli.stderr);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).data.version, packageMetadata.version);
    assert.equal([...paths].some((path) => path.startsWith("tests/")), false);
    assert.equal([...paths].some((path) => path.startsWith("docs/")), false);
    assert.equal(paths.has("AGENTS.md"), false);
    assert.equal(paths.has("package-lock.json"), false);
  });

  it("installs and runs from a clean consumer without resolving the source checkout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "paved-package-smoke-"));
    try {
      const dryRun = spawnSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
      });
      assert.equal(dryRun.error, undefined, dryRun.stderr);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      const [dryRunArtifact] = JSON.parse(dryRun.stdout) as { integrity: string }[];
      assert.ok(dryRunArtifact);

      const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", workspace, "--json"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
      });
      assert.equal(packed.error, undefined, packed.stderr);
      assert.equal(packed.status, 0, packed.stderr);
      const [artifact] = JSON.parse(packed.stdout) as { filename: string; integrity: string }[];
      assert.ok(artifact);
      assert.match(artifact.integrity, /^sha512-/);
      assert.equal(artifact.integrity, dryRunArtifact.integrity, "dry-run and tarball integrity should match");

      const consumerRoot = join(workspace, "consumer");
      const runtimePrefix = join(workspace, "runtime");
      mkdirSync(join(consumerRoot, "src"), { recursive: true });
      writeFileSync(join(consumerRoot, "README.md"), "# Synthetic consumer\n");
      writeFileSync(join(consumerRoot, "src", "index.ts"), "export const answer = 42;\n");
      const appPackagePath = join(consumerRoot, "package.json");
      const appPackage = JSON.stringify({ name: "synthetic-consumer", private: true }, null, 2);
      writeFileSync(appPackagePath, appPackage);

      const installed = spawnSync("npm", [
        "install", "--offline", "--ignore-scripts", "--prefix", runtimePrefix,
        join(workspace, artifact.filename),
      ], { cwd: workspace, encoding: "utf8", shell: false });
      assert.equal(installed.error, undefined, installed.stderr);
      assert.equal(installed.status, 0, installed.stderr);

      const installedRuntime = join(runtimePrefix, "node_modules", "paved-core");
      const executable = join(installedRuntime, "cli", "build", "cli", "index.js");
      assert.equal(existsSync(executable), true, "compiled CLI must be present in installed artifact");
      const invoke = (...args: string[]) => spawnSync(process.execPath, [executable, ...args], {
        cwd: consumerRoot,
        encoding: "utf8",
        shell: false,
      });

      const version = invoke("--version", "--json");
      assert.equal(version.error, undefined, version.stderr);
      assert.equal(version.status, 0, version.stderr);
      const versionResult = JSON.parse(version.stdout) as { status: string; data?: { version: string } };
      assert.equal(versionResult.status, "success");
      assert.equal(versionResult.data?.version, JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version);

      const initialized = invoke("init", "--project", consumerRoot, "--json");
      assert.equal(initialized.error, undefined, initialized.stderr);
      const initResult = JSON.parse(initialized.stdout) as {
        status: string;
        data?: { initialized?: boolean; lifecycleState?: string };
      };
      assert.ok(initialized.status === 0 || initialized.status === 1, initialized.stdout);
      assert.equal(initResult.data?.initialized, true);
      assert.equal(initResult.data?.lifecycleState, "GENERATED");

      const commands = invoke("agent", "commands", "--project", consumerRoot, "--json");
      assert.equal(commands.error, undefined, commands.stderr);
      assert.equal(commands.status, 0, commands.stderr);
      const commandResult = JSON.parse(commands.stdout) as {
        status: string;
        data?: { lifecycleState: string; commands: { name: string; available: boolean }[] };
      };
      assert.equal(commandResult.status, "success");
      assert.ok(["GENERATED", "VALIDATED", "READY"].includes(commandResult.data?.lifecycleState ?? ""));
      assert.equal(commandResult.data?.commands.length, 15);
      assert.equal(commandResult.data?.commands.every((command) => typeof command.available === "boolean"), true);
      assert.equal(commandResult.data?.commands.find((command) => command.name === "init")?.available, false);
      assert.equal(commandResult.data?.commands.find((command) => command.name === "test")?.available, false);

      const status = invoke("status", "--project", consumerRoot, "--json");
      assert.equal(status.error, undefined, status.stderr);
      const statusResult = JSON.parse(status.stdout) as {
        status: string;
        data?: { coreRoot?: string; lifecycleState?: string };
      };
      assert.ok(status.status === 0 || status.status === 1, status.stdout);
      assert.equal(statusResult.data?.coreRoot, realpathSync(join(runtimePrefix, "node_modules", "paved-core")));
      assert.notEqual(statusResult.data?.coreRoot, root);
      assert.equal(statusResult.data?.lifecycleState, initResult.data?.lifecycleState);
      assert.equal(readFileSync(appPackagePath, "utf8"), appPackage, "runtime installation must not modify application dependencies");

      const pavedDirectory = join(consumerRoot, ".paved");
      mkdirSync(join(pavedDirectory, "tools"), { recursive: true });
      mkdirSync(join(pavedDirectory, "tool-implementations"), { recursive: true });
      const tool = parse(readFileSync(join(installedRuntime, "core", "tools", "testing", "run.yaml"), "utf8")) as {
        id: string;
      };
      tool.id = "project.testing.run";
      const implementation = {
        apiVersion: "paved/v1",
        kind: "ToolImplementation",
        id: "project.testing.run",
        tool: tool.id,
        version: "1.0.0",
        contract: "^0.1.0",
        source: "project",
        environments: ["local"],
        invocation: {
          type: "command",
          executable: "node",
          arguments: ["--", ".paved/tools/test-runner.mjs"],
        },
        availability: "available",
      };
      writeFileSync(join(pavedDirectory, "tools", "testing-run.yaml"), stringify(tool));
      writeFileSync(join(pavedDirectory, "tool-implementations", "testing-run.yaml"), stringify(implementation));
      writeFileSync(join(pavedDirectory, "tools", "fixture.test.mjs"), [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'test("clean consumer assertion", () => assert.equal("paved", "paved"));',
      ].join("\n"));
      writeFileSync(join(pavedDirectory, "tools", "test-runner.mjs"), [
        'import { spawnSync } from "node:child_process";',
        'const result = spawnSync(process.execPath, ["--test", ".paved/tools/fixture.test.mjs"], { cwd: process.cwd(), encoding: "utf8", shell: false, env: process.env });',
        'process.stdout.write(JSON.stringify({status: result.status === 0 ? "passed" : "failed", exit_code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? ""}));',
        "process.exitCode = result.status ?? 1;",
      ].join("\n"));
      const commandsWithTesting = invoke("agent", "commands", "--project", consumerRoot, "--json");
      assert.equal(commandsWithTesting.error, undefined, commandsWithTesting.stderr);
      assert.equal(commandsWithTesting.status, 0, commandsWithTesting.stderr);
      const testingCommand = (JSON.parse(commandsWithTesting.stdout) as {
        data?: { commands: { name: string; available: boolean }[] };
      }).data?.commands.find((command) => command.name === "test");
      assert.equal(testingCommand?.available, true, JSON.stringify(testingCommand));

      const tested = invoke("test", "--project", consumerRoot, "--json");
      assert.equal(tested.error, undefined, tested.stderr);
      assert.equal(tested.status, 0, tested.stderr || tested.stdout);
      const testResult = JSON.parse(tested.stdout) as {
        status: string;
        data?: { verification: string; evidence: string; tool: { status: string; tool: { id: string } } };
      };
      assert.equal(testResult.status, "success");
      assert.equal(testResult.data?.verification, "not-run");
      assert.equal(testResult.data?.tool.status, "succeeded");
      assert.equal(testResult.data?.tool.tool.id, "project.testing.run");
      assert.equal(existsSync(join(consumerRoot, testResult.data!.evidence)), true);
      assert.equal(readFileSync(appPackagePath, "utf8"), appPackage, "governed test must not modify application dependencies");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
