import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AGENT_COMMANDS } from "../../integrations/shared/commands.ts";
import { createRegistry } from "../../cli/lib/schemas.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cli = join(root, "cli/index.ts");
let counter = 0;

type Result = {
  command: string;
  status: "success" | "warning" | "failed" | "awaiting_input";
  data?: Record<string, unknown>;
  diagnostics: { category: string; code: string; severity: string; message: string }[];
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
  it("validates every shared command descriptor against the AgentIntegration schema", () => {
    const registry = createRegistry(join(root, "schemas"), ["paved/v1"]);
    const document = {
      apiVersion: "paved/v1",
      kind: "AgentIntegration",
      id: "paved.integration.codex",
      version: "1.0.0",
      target: { agent: "codex", version_range: ">=1.0.0" },
      supported_paved_api_versions: ["paved/v1"],
      supported_core_range: ">=1.0.0",
      capabilities: [
        "context", "skills", "workflows", "tools", "verification", "status",
        "diagnostics", "lifecycle", "command-discovery", "command-invocation", "compatibility",
      ],
      commands: AGENT_COMMANDS.map((command) => ({
        id: command.id,
        group: command.group,
        description: command.description,
        input: command.input,
        output: command.output,
        required_context: command.requiredContext,
        required_capabilities: command.requiredCapabilities,
        allowed_side_effects: command.allowedSideEffects,
        lifecycle: command.lifecycle,
        ...(command.tool === undefined ? {} : { tool: command.tool }),
        cli_command: command.cliCommand,
        failure_semantics: command.failureSemantics,
        interaction: command.interaction,
        decision_sources: command.decisionSources,
        answer_channels: command.answerChannels,
      })),
      scope: "project",
      provenance: { owner: "paved", generated: true },
    };
    const validation = registry.validate(document);
    assert.equal(validation.valid, true, validation.errors.join("; "));
  });

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

      const commandsBefore = invoke(project, "agent", "commands");
      assert.equal(commandsBefore.result.status, "success");
      const beforeData = commandsBefore.result.data as { lifecycleState: string; commands: { name: string; available: boolean; interaction: string; decisionSources: string[]; answerChannels: string[] }[] };
      assert.equal(beforeData.lifecycleState, "UNINITIALIZED");
      assert.equal(beforeData.commands.length, 15);
      assert.equal(beforeData.commands.find((command) => command.name === "init")?.available, true);
      assert.equal(beforeData.commands.find((command) => command.name === "plan")?.available, false);
      assert.equal(beforeData.commands.find((command) => command.name === "init")?.interaction, "conversational");
      assert.deepEqual(beforeData.commands.find((command) => command.name === "status")?.decisionSources, []);

      const unavailablePlan = invoke(project, "agent", "command", "plan");
      assert.equal(unavailablePlan.exitCode, 4);
      assert.equal(unavailablePlan.result.diagnostics[0]?.code, "PAVED_AGENT_COMMAND_UNAVAILABLE");
      assert.ok(unavailablePlan.result.diagnostics[0]?.message.includes("UNINITIALIZED"));

      const initContract = invoke(project, "agent", "command", "init");
      assert.equal(initContract.result.status, "success");
      assert.equal((initContract.result.data as { invocation: string }).invocation, "agent-orchestrated");
      const invalidCommandArguments = invoke(project, "agent", "command", "init", "unexpected");
      assert.equal(invalidCommandArguments.exitCode, 2);
      assert.equal(invalidCommandArguments.result.diagnostics[0]?.code, "PAVED_AGENT_USAGE");

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

      const commandsAfter = invoke(project, "agent", "commands", "codex");
      const afterData = commandsAfter.result.data as { lifecycleState: string; integration: string; commands: { name: string; available: boolean; reason?: string }[] };
      assert.equal(afterData.integration, "codex");
      assert.equal(afterData.commands.find((command) => command.name === "plan")?.available, true);
      assert.equal(afterData.commands.find((command) => command.name === "test")?.available, false);
      assert.match(afterData.commands.find((command) => command.name === "test")?.reason ?? "", /cannot be executed/);
      assert.equal(afterData.commands.find((command) => command.name === "verify")?.available, false);
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
