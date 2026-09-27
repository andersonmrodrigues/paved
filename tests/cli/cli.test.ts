import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderHuman, renderJson } from "../../cli/output.ts";
import {
  dispatchCli,
  type CommandHandler,
  type CommandInvocation,
  type CommandName,
} from "../../cli/runtime.ts";
import { resolveCoreRoot, resolveProjectRoot } from "../../cli/paths.ts";
import {
  createDiagnostic,
  createResult,
  type DiagnosticCategory,
  exitCode,
  primaryCategory,
} from "../../cli/result.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let sandboxCounter = 0;

function sandbox(name: string): string {
  const dir = join(ROOT, "tests/cli/.sandbox", `${name}-${process.pid}-${++sandboxCounter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(projectRoot: string): void {
  mkdirSync(join(projectRoot, ".paved"), { recursive: true });
  writeFileSync(join(projectRoot, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\n");
}

function captureHandler(invocations: CommandInvocation[]): CommandHandler {
  return (invocation) => {
    invocations.push(invocation);
    return createResult({
      command: invocation.command,
      status: "success",
      data: {
        adapters: invocation.flags.adapters,
        dryRun: invocation.flags.dryRun,
        json: invocation.flags.json,
        selectors: invocation.selectors,
        projectRoot: invocation.paths.projectRoot,
        coreRoot: invocation.paths.coreRoot,
      },
    });
  };
}

function result(...categories: DiagnosticCategory[]) {
  return createResult({
    command: "synthetic",
    status: categories.length === 0 ? "success" : categories.every((category) => category === "findings") ? "warning" : "failed",
    diagnostics: categories.map((category, index) => createDiagnostic({
      category,
      severity: category === "findings" ? "warning" : "error",
      code: `PAVED_${index}`,
      component: "cli.test",
      message: `Diagnostic ${index} for ${category}`,
      remediation: `Fix ${category}`,
    })),
  });
}

describe("CLI result exit behavior", () => {
  it("maps each result category to a stable exit code", () => {
    assert.equal(exitCode(createResult({ command: "synthetic", status: "success" })), 0);
    assert.equal(exitCode(result("findings")), 1);
    assert.equal(exitCode(result("usage")), 2);
    assert.equal(exitCode(result("environment")), 3);
    assert.equal(exitCode(result("config")), 4);
    assert.equal(exitCode(result("resolution")), 5);
    assert.equal(exitCode(result("generation/update")), 6);
    assert.equal(exitCode(result("verification")), 7);
    assert.equal(exitCode(result("conflict")), 8);
    assert.equal(exitCode(result("internal")), 9);
  });

  it("selects the deterministic primary category regardless of diagnostic order", () => {
    const first = result("usage", "verification", "config");
    const second = result("config", "usage", "verification");

    assert.equal(primaryCategory(first), "verification");
    assert.equal(primaryCategory(second), "verification");
    assert.equal(exitCode(first), 7);
    assert.equal(exitCode(second), 7);
  });

  it("maps warning status without diagnostics to findings exit code", () => {
    assert.equal(exitCode(createResult({ command: "synthetic", status: "warning" })), 1);
  });

  it("maps malformed failed results without blocking diagnostics to internal errors", () => {
    const withoutDiagnostics = createResult({ command: "synthetic", status: "failed" });
    const withOnlyFindings = createResult({
      command: "synthetic",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          category: "findings",
          severity: "warning",
          code: "PAVED_WARNING",
          component: "cli.test",
          message: "Non-blocking finding",
        }),
      ],
    });

    assert.equal(primaryCategory(withoutDiagnostics), "internal");
    assert.equal(exitCode(withoutDiagnostics), 9);
    assert.equal(primaryCategory(withOnlyFindings), "internal");
    assert.equal(exitCode(withOnlyFindings), 9);
    assert.deepEqual(withOnlyFindings.diagnostics.map((diagnostic) => diagnostic.category), ["findings", "internal"]);
    assert.match(
      withOnlyFindings.diagnostics.at(-1)?.message ?? "",
      /failed result.*blocking diagnostic/i,
    );
  });

  it("gives internal diagnostics precedence over other blocking categories", () => {
    const mixed = result("conflict", "internal", "verification");

    assert.equal(primaryCategory(mixed), "internal");
    assert.equal(exitCode(mixed), 9);
  });

  it("retains all diagnostics while selecting the primary failure", () => {
    const diagnostics = result("usage", "findings", "conflict").diagnostics;

    assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.category), ["usage", "findings", "conflict"]);
    assert.equal(diagnostics.length, 3);
  });
});

describe("CLI result renderers", () => {
  it("renders human and JSON output from the same structured result", () => {
    const structured = createResult({
      command: "doctor",
      status: "failed",
      data: { checked: 2 },
      diagnostics: [
        createDiagnostic({
          category: "config",
          severity: "error",
          code: "PAVED_CONFIG_INVALID",
          component: "manifest",
          message: "Manifest is invalid",
          remediation: "Fix .paved/manifest.yaml",
        }),
        createDiagnostic({
          category: "findings",
          severity: "warning",
          code: "PAVED_WARNING",
          component: "verification",
          message: "Verification profile is missing",
        }),
      ],
    });

    const json = JSON.parse(renderJson(structured)) as typeof structured;
    const human = renderHuman(structured);

    assert.deepEqual(json, structured);
    for (const diagnostic of structured.diagnostics) {
      assert.match(human, new RegExp(diagnostic.code));
      assert.match(human, new RegExp(diagnostic.message));
      assert.match(human, new RegExp(diagnostic.component));
    }
    assert.doesNotMatch(human, /stack/i);
    assert.doesNotMatch(renderJson(structured), /stack/i);
  });
});

describe("CLI argument parsing and dispatch", () => {
  it("recognizes the six production command names and dispatches injectable handlers", async () => {
    const commands: CommandName[] = ["init", "update", "generate", "verify", "status", "doctor"];
    const cwd = sandbox("commands");
    try {
      const invocations: CommandInvocation[] = [];
      const handlers = Object.fromEntries(commands.map((command) => [command, captureHandler(invocations)]));

      for (const command of commands) {
        const dispatched = await dispatchCli({
          argv: [command],
          cwd,
          executablePath: join(ROOT, "cli/index.ts"),
          handlers,
        });

        assert.equal(dispatched.status, "success");
        assert.equal(dispatched.command, command);
      }

      assert.deepEqual(invocations.map((invocation) => invocation.command), commands);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supports help and version without running command handlers", async () => {
    const cwd = sandbox("help-version");
    try {
      const handlers = {
        status: () => {
          throw new Error("status handler should not run for help");
        },
      } satisfies Partial<Record<CommandName, CommandHandler>>;

      const help = await dispatchCli({ argv: ["status", "--help"], cwd, executablePath: join(ROOT, "cli/index.ts"), handlers });
      const version = await dispatchCli({ argv: ["--version"], cwd, executablePath: join(ROOT, "cli/index.ts"), handlers });

      assert.equal(help.status, "success");
      assert.equal(help.command, "help");
      assert.match(renderHuman(help), /Usage:/);
      assert.equal(version.status, "success");
      assert.equal(version.command, "version");
      assert.equal((version.data as { version: string }).version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unknown commands, unknown flags, and missing flag values as usage errors", async () => {
    const cwd = sandbox("usage-errors");
    try {
      for (const argv of [["deploy"], ["status", "--dry-run"], ["status", "--project"], ["status", "--adapter"]]) {
        const result = await dispatchCli({ argv, cwd, executablePath: join(ROOT, "cli/index.ts") });

        assert.equal(result.status, "failed");
        assert.equal(exitCode(result), 2);
        assert.equal(primaryCategory(result), "usage");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("parses repeatable adapters, project paths, json, dry-run, and command selectors", async () => {
    const workspace = sandbox("flags");
    try {
      const cwd = join(workspace, "runner");
      const project = join(workspace, "target");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(project, { recursive: true });
      const invocations: CommandInvocation[] = [];

      const result = await dispatchCli({
        argv: [
          "generate",
          "--project",
          "../target",
          "--adapter",
          "technology/java",
          "--adapter",
          "technology/angular",
          "--json",
          "--dry-run",
          "project-context/architecture",
          "verification",
        ],
        cwd,
        executablePath: join(ROOT, "cli/index.ts"),
        handlers: { generate: captureHandler(invocations) },
      });

      assert.equal(result.status, "success");
      assert.equal(invocations.length, 1);
      assert.deepEqual(invocations[0]?.flags.adapters, ["technology/java", "technology/angular"]);
      assert.equal(invocations[0]?.flags.json, true);
      assert.equal(invocations[0]?.flags.dryRun, true);
      assert.deepEqual(invocations[0]?.selectors, ["project-context/architecture", "verification"]);
      assert.equal(invocations[0]?.paths.projectRoot, project);
      assert.equal(invocations[0]?.paths.coreRoot, ROOT);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("CLI project and Core path resolution", () => {
  it("finds the nearest ancestor manifest from a nested cwd", () => {
    const workspace = sandbox("nearest-manifest");
    try {
      const outer = join(workspace, "outer");
      const inner = join(outer, "packages/app");
      const nested = join(inner, "src/deep");
      writeManifest(outer);
      writeManifest(inner);
      mkdirSync(nested, { recursive: true });

      const resolvedProject = resolveProjectRoot({ cwd: nested });

      assert.equal(resolvedProject.projectRoot, inner);
      assert.equal(resolvedProject.manifestPath, join(inner, ".paved/manifest.yaml"));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resolves explicit project paths relative to cwd", () => {
    const workspace = sandbox("explicit-project");
    try {
      const cwd = join(workspace, "runner");
      const project = join(workspace, "consumer");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(project, { recursive: true });

      const resolvedProject = resolveProjectRoot({ cwd, project: "../consumer" });

      assert.equal(resolvedProject.projectRoot, project);
      assert.equal(resolvedProject.manifestPath, undefined);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("defaults uninitialized projects to cwd without guessing package or git parents", () => {
    const workspace = sandbox("uninitialized");
    try {
      const parent = join(workspace, "parent");
      const cwd = join(parent, "child");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(parent, "package.json"), "{\"name\":\"unrelated\"}\n");

      const resolvedProject = resolveProjectRoot({ cwd });

      assert.equal(resolvedProject.projectRoot, cwd);
      assert.equal(resolvedProject.manifestPath, undefined);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports inaccessible or non-directory project paths as environment failures", async () => {
    const workspace = sandbox("bad-project");
    try {
      const projectFile = join(workspace, "not-a-directory");
      writeFileSync(projectFile, "not a directory\n");

      const result = await dispatchCli({
        argv: ["status", "--project", "./not-a-directory"],
        cwd: workspace,
        executablePath: join(ROOT, "cli/index.ts"),
      });

      assert.equal(result.status, "failed");
      assert.equal(exitCode(result), 3);
      assert.equal(primaryCategory(result), "environment");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("resolves Core from the executable location rather than the consumer cwd", () => {
    const workspace = sandbox("core-root");
    try {
      const consumer = join(workspace, "consumer");
      mkdirSync(consumer, { recursive: true });

      assert.equal(resolveCoreRoot({ executablePath: join(ROOT, "cli/index.ts") }), ROOT);
      assert.notEqual(resolve(consumer), ROOT);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("CLI executable entry point", () => {
  it("prints one help output mode and returns success", () => {
    const result = spawnSync(process.execPath, ["./cli/index.ts", "--help"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout.trim(), /^\{/);
  });

  it("prints JSON when requested and returns usage status for unknown commands", () => {
    const result = spawnSync(process.execPath, ["./cli/index.ts", "--json", "not-a-command"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout) as { command: string; diagnostics: { category: string }[] };
    assert.equal(parsed.command, "not-a-command");
    assert.equal(parsed.diagnostics[0]?.category, "usage");
  });

  it("does not call process.exit from the entry point", () => {
    assert.doesNotMatch(readFileSync(join(ROOT, "cli/index.ts"), "utf8"), /process\.exit\s*\(/);
    assert.equal(existsSync(join(ROOT, "cli/index.ts")), true);
  });
});
