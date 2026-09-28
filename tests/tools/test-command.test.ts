import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { loadYaml } from "../../cli/lib/documents.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import type { CommandResult } from "../../cli/result.ts";
import { at, formatErrors, schemas } from "../helpers.ts";
import type { ToolContract, ToolImplementation } from "../../cli/lib/tools.ts";

const ROOT = join(import.meta.dirname, "../..");

function sandbox(prefix: string): { parent: string; project: string } {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const project = join(parent, "consumer");
  mkdirSync(project);
  return { parent, project };
}

async function initialize(project: string): Promise<void> {
  const result = await dispatchCli({
    argv: ["init", "--no-generate", "--project", project, "--json"],
    cwd: project,
    executablePath: join(ROOT, "cli/index.ts"),
  });
  assert.equal(result.status, "success", JSON.stringify(result));
}

async function runTest(project: string): Promise<CommandResult> {
  return dispatchCli({
    argv: ["test", "--project", project, "--json"],
    cwd: project,
    executablePath: join(ROOT, "cli/index.ts"),
  });
}

function projectTool(project: string): { tool: ToolContract; implementation: ToolImplementation } {
  const tool = structuredClone(loadYaml(at("core", "tools", "testing", "run.yaml"))) as ToolContract;
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
  } as ToolImplementation;
  mkdirSync(join(project, ".paved/tools"), { recursive: true });
  mkdirSync(join(project, ".paved/tool-implementations"), { recursive: true });
  writeFileSync(join(project, ".paved/tools/testing-run.yaml"), stringify(tool));
  writeFileSync(join(project, ".paved/tool-implementations/testing-run.yaml"), stringify(implementation));
  return { tool, implementation };
}

function secondProjectTool(project: string, authorized = true): void {
  const { tool, implementation } = projectTool(project);
  const alternative = { ...tool, id: "project.testing.alternative" };
  if (!authorized) alternative.permissions = ["repository-write"];
  writeFileSync(join(project, ".paved/tools/testing-alternative.yaml"), stringify(alternative));
  writeFileSync(join(project, ".paved/tool-implementations/testing-alternative.yaml"),
    stringify({ ...implementation, id: "project.testing.alternative", tool: alternative.id }));
}

describe("testing tool ambiguity", () => {
  it("asks among authorized tools and executes the selected one", async () => {
    const { parent, project } = sandbox("paved-test-choice-");
    try {
      await initialize(project);
      secondProjectTool(project);
      writeFileSync(join(project, ".paved/tools/test-runner.mjs"),
        'process.stdout.write(JSON.stringify({status:"passed"}));');
      const discovery = await dispatchCli({ argv: ["agent", "commands", "--project", project, "--json"] });
      assert.equal((discovery.data as { commands: { name: string; available: boolean }[] })
        .commands.find((command) => command.name === "test")?.available, true);
      const asked = await runTest(project);
      assert.equal(asked.status, "awaiting_input", JSON.stringify(asked));
      assert.equal(asked.decisions?.[0]?.options.length, 2);
      const decision = asked.decisions![0]!;
      const answered = await dispatchCli({
        argv: ["test", "--project", project, "--answer", `${decision.id}=${decision.options[0]!.id}`,
          "--answered-by", "tester@example.com", "--json"],
      });
      assert.equal(answered.status, "success", JSON.stringify(answered));
      const third = parse(readFileSync(join(project, ".paved/tools/testing-alternative.yaml"), "utf8")) as ToolContract;
      const thirdBinding = parse(readFileSync(join(project, ".paved/tool-implementations/testing-alternative.yaml"), "utf8")) as ToolImplementation;
      writeFileSync(join(project, ".paved/tools/testing-third.yaml"),
        stringify({ ...third, id: "project.testing.third" }));
      writeFileSync(join(project, ".paved/tool-implementations/testing-third.yaml"),
        stringify({ ...thirdBinding, id: "project.testing.third", tool: "project.testing.third" }));
      const changed = await runTest(project);
      assert.equal(changed.status, "awaiting_input", JSON.stringify(changed));
      assert.equal(changed.decisions?.[0]?.options.length, 3);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("does not offer a tool whose permissions prevent authorization", async () => {
    const { parent, project } = sandbox("paved-test-unauthorized-");
    try {
      await initialize(project);
      secondProjectTool(project, false);
      writeFileSync(join(project, ".paved/tools/test-runner.mjs"),
        'process.stdout.write(JSON.stringify({status:"passed"}));');
      const result = await runTest(project);
      assert.equal(result.status, "success", JSON.stringify(result));
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});

function writePassingTest(project: string, stderr = ""): void {
  writeFileSync(join(project, ".paved/tools/fixture.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'test("synthetic consumer assertion", () => assert.equal(2 + 2, 4));',
  ].join("\n"));
  writeFileSync(join(project, ".paved/tools/test-runner.mjs"), [
    'import { spawnSync } from "node:child_process";',
    'const result = spawnSync(process.execPath, ["--test", ".paved/tools/fixture.test.mjs"], { cwd: process.cwd(), encoding: "utf8", shell: false, env: process.env });',
    'process.stdout.write(JSON.stringify({status: result.status === 0 ? "passed" : "failed", exit_code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? ""}));',
    ...(stderr ? [`process.stderr.write(${JSON.stringify(stderr)});`] : []),
    "process.exitCode = result.status ?? 1;",
  ].join("\n"));
}

describe("governed test command", () => {
  it("executes only an explicitly declared project testing Tool and records non-verification evidence", async () => {
    const { parent, project } = sandbox("paved-test-command-");
    try {
      await initialize(project);
      const { tool, implementation } = projectTool(project);
      writeFileSync(join(project, ".paved/tools/test-runner.mjs"), [
        'process.stdout.write(JSON.stringify({status:"passed"}));',
        'process.stderr.write("password=do-not-persist");',
      ].join("\n"));
      writePassingTest(project, "token=do-not-persist");
      for (const document of [tool, implementation]) {
        const validation = schemas().validate(document);
        assert.ok(validation.valid, formatErrors(document.id, validation.errors));
      }

      const discovery = await dispatchCli({
        argv: ["agent", "commands", "--project", project, "--json"],
        cwd: project,
        executablePath: join(ROOT, "cli/index.ts"),
      });
      const discoveredTest = (discovery.data as { commands: { name: string; available: boolean }[] })
        .commands.find((command) => command.name === "test");
      assert.equal(discoveredTest?.available, true, JSON.stringify(discoveredTest));

      const result = await runTest(project);
      assert.equal(result.status, "success", JSON.stringify(result));
      const data = result.data as { verification: string; evidence: string; tool: { status: string; tool: { id: string } } };
      assert.equal(data.verification, "not-run");
      assert.equal(data.tool.status, "succeeded");
      assert.equal(data.tool.tool.id, "project.testing.run");
      assert.match(data.evidence, /^\.paved\/generated\/evidence\/test-.*\.yaml$/);
      const evidence = parse(readFileSync(join(project, data.evidence), "utf8")) as {
        completion: { status: string; verification: string };
        artifacts: { source: { location: string } }[];
      };
      const validation = schemas().validate(evidence);
      assert.ok(validation.valid, formatErrors(data.evidence, validation.errors));
      assert.deepEqual(evidence.completion, {
        status: "incomplete",
        verification: "unverified",
        decided_by: "paved",
        criteria: [{ statement: "Paved verification was not run by the testing command.", met: false }],
        notes: "A testing Tool result is not a Paved verification result.",
      });
      const log = readFileSync(join(project, evidence.artifacts[0]!.source.location), "utf8");
      assert.match(log, /\[REDACTED\]/);
      assert.doesNotMatch(log, /do-not-persist/);

      writeFileSync(join(project, ".paved/tools/test-runner.mjs"), 'process.stdout.write("not-json");');
      const malformed = await runTest(project);
      assert.equal(malformed.status, "failed");
      assert.equal(malformed.diagnostics[0]?.code, "PAVED_TEST_OUTPUT_MALFORMED");
      const malformedData = malformed.data as { evidence: string; tool: { status: string; error_code: string } };
      assert.equal(malformedData.tool.status, "failed");
      assert.equal(malformedData.tool.error_code, "malformed-output");
      const malformedEvidence = parse(readFileSync(join(project, malformedData.evidence), "utf8")) as {
        artifacts: { source: { location: string } }[];
      };
      const malformedLog = readFileSync(join(project, malformedEvidence.artifacts[0]!.source.location), "utf8");
      assert.match(malformedLog, /"error_code":"malformed-output"/);
      assert.doesNotMatch(malformedLog, /"status":"passed"/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses to infer authorization from repository scripts or a Tool contract without a binding", async () => {
    const { parent, project } = sandbox("paved-test-unbound-");
    try {
      await initialize(project);
      mkdirSync(join(project, ".paved/tools"), { recursive: true });
      writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "touch should-not-run" } }));
      const result = await runTest(project);
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_TEST_IMPLEMENTATION_UNAVAILABLE");
      assert.equal(existsSync(join(project, "should-not-run")), false);

      const { tool } = projectTool(project);
      rmSync(join(project, ".paved/tool-implementations"), { recursive: true, force: true });
      const resultWithoutImplementation = await runTest(project);
      assert.equal(resultWithoutImplementation.status, "failed");
      assert.equal(resultWithoutImplementation.diagnostics[0]?.code, "PAVED_TEST_IMPLEMENTATION_UNAVAILABLE");
      assert.ok(tool.id.startsWith("project."));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("records a timed-out Tool as failed evidence", async () => {
    const { parent, project } = sandbox("paved-test-timeout-");
    try {
      await initialize(project);
      const { tool } = projectTool(project);
      tool.timeout_seconds = 1;
      writeFileSync(join(project, ".paved/tools/testing-run.yaml"), stringify(tool));
      writeFileSync(join(project, ".paved/tools/test-runner.mjs"), "setTimeout(() => process.stdout.write('{}'), 10000);\n");

      const result = await runTest(project);
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics[0]?.code, "PAVED_TEST_TOOL_FAILED");
      const data = result.data as { evidence: string; tool: { status: string; error_code: string } };
      assert.equal(data.tool.status, "timed-out");
      assert.equal(data.tool.error_code, "timeout");
      const evidencePath = join(project, data.evidence);
      assert.equal(existsSync(evidencePath), true);
      const evidence = parse(readFileSync(evidencePath, "utf8")) as { artifacts: { source: { location: string } }[] };
      const log = readFileSync(join(project, evidence.artifacts[0]!.source.location), "utf8");
      assert.match(log, /"status":"timed-out"/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects unsafe traversal inputs and working directories before launching", async () => {
    const { parent, project } = sandbox("paved-test-path-");
    try {
      await initialize(project);
      const { tool, implementation } = projectTool(project);
      tool.inputs = [{ name: "scope", description: "Test scope", type: "path", required: true }];
      implementation.invocation.input_bindings = [{ input: "scope" }];
      writeFileSync(join(project, ".paved/tools/testing-run.yaml"), stringify(tool));
      writeFileSync(join(project, ".paved/tool-implementations/testing-run.yaml"), stringify(implementation));
      writeFileSync(join(project, ".paved/tools/test-runner.mjs"), 'process.stdout.write(JSON.stringify({status:"passed"}));');
      writePassingTest(project);

      const inputs = await dispatchCli({
        argv: ["test", "--project", project, "--inputs", '{"scope":"../outside"}', "--json"],
        cwd: project,
        executablePath: join(ROOT, "cli/index.ts"),
      });
      assert.equal(inputs.status, "failed");
      assert.equal(inputs.diagnostics[0]?.code, "PAVED_TEST_INPUT_INVALID", JSON.stringify(inputs));

      (implementation.invocation as ToolImplementation["invocation"] & { working_directory?: string }).working_directory = "../";
      writeFileSync(join(project, ".paved/tool-implementations/testing-run.yaml"), stringify(implementation));
      const workingDirectory = await runTest(project);
      assert.equal(workingDirectory.status, "failed");
      assert.equal(workingDirectory.diagnostics[0]?.code, "PAVED_TEST_CONTENT_INVALID");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
