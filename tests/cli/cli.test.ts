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
  EXIT_CODES,
  type ExitCategory,
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

describe("CLI Task 7 output and dispatch regressions", () => {
  it("dispatches every command with every primary exit category without changing exit mapping", async () => {
    const commands: CommandName[] = ["init", "update", "generate", "verify", "status", "doctor"];
    const categories: ExitCategory[] = [
      "success",
      "findings",
      "usage",
      "environment",
      "config",
      "resolution",
      "generation/update",
      "verification",
      "conflict",
      "internal",
    ];
    const cwd = sandbox("dispatch-categories");
    try {
      for (const command of commands) {
        for (const category of categories) {
          const result = await dispatchCli({
            argv: [command],
            cwd,
            executablePath: join(ROOT, "cli/index.ts"),
            handlers: {
              [command]: () => category === "success"
                ? createResult({ command, status: "success" })
                : createResult({
                    command,
                    status: category === "findings" ? "warning" : "failed",
                    diagnostics: [
                      createDiagnostic({
                        severity: category === "findings" ? "warning" : "error",
                        category,
                        code: `PAVED_${String(category).toUpperCase().replace(/[^A-Z]+/g, "_")}`,
                        component: "cli.test",
                        message: `Synthetic ${category} result`,
                      }),
                    ],
                  }),
            },
          });

          assert.equal(primaryCategory(result), category);
          assert.equal(exitCode(result), EXIT_CODES[category]);
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps primary category precedence stable when dispatch returns mixed diagnostics", async () => {
    const cwd = sandbox("dispatch-precedence");
    try {
      const result = await dispatchCli({
        argv: ["verify"],
        cwd,
        executablePath: join(ROOT, "cli/index.ts"),
        handlers: {
          verify: () => createResult({
            command: "verify",
            status: "failed",
            diagnostics: [
              createDiagnostic({
                severity: "warning",
                category: "findings",
                code: "PAVED_WARNING",
                component: "cli.test",
                message: "warning retained",
              }),
              createDiagnostic({
                severity: "error",
                category: "verification",
                code: "PAVED_VERIFY_FAILED",
                component: "cli.test",
                message: "verification failed",
              }),
              createDiagnostic({
                severity: "error",
                category: "config",
                code: "PAVED_CONFIG_FAILED",
                component: "cli.test",
                message: "config failed",
              }),
            ],
          }),
        },
      });

      assert.equal(primaryCategory(result), "verification");
      assert.equal(exitCode(result), 7);
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
        "PAVED_WARNING",
        "PAVED_VERIFY_FAILED",
        "PAVED_CONFIG_FAILED",
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not expose stack traces when dispatched handlers throw", async () => {
    const cwd = sandbox("thrown-handler");
    try {
      const result = await dispatchCli({
        argv: ["status"],
        cwd,
        executablePath: join(ROOT, "cli/index.ts"),
        handlers: {
          status: () => {
            throw new Error("Synthetic handler failure");
          },
        },
      });
      const human = renderHuman(result);
      const json = renderJson(result);

      assert.equal(primaryCategory(result), "internal");
      assert.match(human, /Synthetic handler failure/);
      assert.match(json, /Synthetic handler failure/);
      assert.doesNotMatch(human, /\n\s*at\s+/);
      assert.doesNotMatch(json, /\n\s*at\s+/);
      assert.doesNotMatch(json, /stack/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("shows command-specific help with only implemented flags and inputs", async () => {
    const cwd = sandbox("command-help");
    const expectations: Record<CommandName, { includes: readonly string[]; excludes: readonly string[] }> = {
      init: {
        includes: ["Usage: paved init", "--dry-run", "--no-generate"],
        excludes: ["--adapter <id>", "[generator-id...]"],
      },
      update: {
        includes: ["Usage: paved update", "--dry-run"],
        excludes: ["--adapter <id>", "--no-generate", "[generator-id...]"],
      },
      generate: {
        includes: ["Usage: paved generate", "[generator-id...]", "--dry-run"],
        excludes: ["--adapter <id>", "--no-generate"],
      },
      verify: {
        includes: ["Usage: paved verify", "--adapter <id>"],
        excludes: ["--dry-run", "--no-generate", "[generator-id...]"],
      },
      status: {
        includes: ["Usage: paved status", "--adapter <id>"],
        excludes: ["--dry-run", "--no-generate", "[generator-id...]"],
      },
      doctor: {
        includes: ["Usage: paved doctor", "--adapter <id>"],
        excludes: ["--dry-run", "--no-generate", "[generator-id...]"],
      },
      gardener: {
        includes: ["Usage: paved gardener", "--dry-run"],
        excludes: ["--adapter <id>", "--no-generate", "[generator-id...]"],
      },
    };
    try {
      for (const [command, expectation] of Object.entries(expectations) as [CommandName, typeof expectations[CommandName]][]) {
        const help = await dispatchCli({
          argv: [command, "--help"],
          cwd,
          executablePath: join(ROOT, "cli/index.ts"),
        });
        const usage = (help.data as { usage: string }).usage;

        assert.equal(exitCode(help), 0);
        for (const text of expectation.includes) assert.match(usage, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        for (const text of expectation.excludes) assert.doesNotMatch(usage, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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

  it("returns a structured diagnostic when package metadata cannot be read for version", async () => {
    const workspace = sandbox("malformed-package-version");
    try {
      const coreRoot = join(workspace, "core");
      const executablePath = join(coreRoot, "cli/index.ts");
      mkdirSync(join(coreRoot, "cli"), { recursive: true });
      writeFileSync(join(coreRoot, "manifest.yaml"), "apiVersion: paved/v1\nkind: Core\n");
      writeFileSync(join(coreRoot, "package.json"), "{\"version\":");
      writeFileSync(executablePath, "");

      let version: Awaited<ReturnType<typeof dispatchCli>> | undefined;
      await assert.doesNotReject(async () => {
        version = await dispatchCli({ argv: ["--version"], cwd: workspace, executablePath });
      });

      assert.equal(version?.status, "failed");
      assert.equal(version?.command, "version");
      assert.equal(primaryCategory(version), "internal");
      assert.equal(exitCode(version), 9);
      assert.match(version.diagnostics[0]?.message ?? "", /JSON|package/i);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
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

      const status = await dispatchCli({
        argv: [
          "status",
          "--project",
          "../target",
          "--adapter",
          "technology/java",
          "--adapter",
          "technology/angular",
          "--json",
        ],
        cwd,
        executablePath: join(ROOT, "cli/index.ts"),
        handlers: { status: captureHandler(invocations) },
      });
      const generate = await dispatchCli({
        argv: [
          "generate",
          "--project",
          "../target",
          "--dry-run",
          "project-context/architecture",
          "verification",
        ],
        cwd,
        executablePath: join(ROOT, "cli/index.ts"),
        handlers: { generate: captureHandler(invocations) },
      });

      assert.equal(status.status, "success");
      assert.equal(generate.status, "success");
      assert.equal(invocations.length, 2);
      assert.deepEqual(invocations[0]?.flags.adapters, ["technology/java", "technology/angular"]);
      assert.equal(invocations[0]?.flags.json, true);
      assert.equal(invocations[0]?.paths.projectRoot, project);
      assert.equal(invocations[0]?.paths.coreRoot, ROOT);
      assert.equal(invocations[1]?.flags.dryRun, true);
      assert.deepEqual(invocations[1]?.selectors, ["project-context/architecture", "verification"]);
      assert.equal(invocations[1]?.paths.projectRoot, project);
      assert.equal(invocations[1]?.paths.coreRoot, ROOT);
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
