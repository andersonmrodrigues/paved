import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { writeReviewBrief } from "../../cli/lib/review-block.ts";
import type { Run } from "../../cli/lib/workflow-runs.ts";
import type { CommandResult } from "../../cli/result.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
afterEach(cleanupTemporaryDirectories);
const data = (result: CommandResult) => result.data as { run: string; currentPhase: string; nextAction: string; toolApproval?: { id: string; run: string; phase: string; tools: { id: string; implementation: { invocation: unknown } }[] }; phaseContext: { phase: string } };

function fixture(kind: string, phase: string, action: string, suite: boolean | "choice" = false) {
  const fixtureCore = temporaryDirectory("paved-policy-core");
  const root = temporaryDirectory("paved-policy-project");
  for (const path of ["manifest.yaml", "package.json", "VERSION", "schemas", "core", "generators", "adapters"]) cpSync(join(core, path), join(fixtureCore, path), { recursive: true });
  const file = join(fixtureCore, `core/workflows/${kind}/workflow.yaml`);
  const workflow = parse(readFileSync(file, "utf8"));
  const ids = suite === "choice" ? ["core.testing.run", "core.testing.other"] : suite ? ["project.testing-detected-a.run", "project.testing-detected-b.run"] : ["core.testing.run"];
  const selected = ids.at(-1)!;
  workflow.tool_policies = [{ id: "bounded", allow: [], ask: [], deny: [], [action]: [selected] }];
  workflow.phases.find((p: { phase: string }) => p.phase === phase).tool_policies = ["bounded"];
  writeFileSync(file, stringify(workflow));
  writeFileSync(join(root, "README.md"), "# Consumer\n");
  writeFileSync(join(root, "feature.js"), "export const enabled = false;\n");
  mkdirSync(join(root, ".paved/tool-implementations"), { recursive: true });
  for (const [index, id] of ids.entries()) {
    if (suite && id !== "core.testing.run") {
      const tool = parse(readFileSync(join(core, "core/tools/testing/run.yaml"), "utf8"));
      writeFileSync(join(fixtureCore, `core/tools/testing/suite-${index}.yaml`), stringify({ ...tool, id }));
    }
    writeFileSync(join(root, `.paved/tool-implementations/run-${index}.yaml`), stringify({
      apiVersion: "paved/v1", kind: "ToolImplementation", id: `project.testing.binding-${index}`, tool: id,
      version: "0.1.0", contract: "^0.1.0", source: "project", environments: ["local"], availability: "available",
      invocation: { type: "command", executable: process.execPath, arguments: ["-e", "require('node:fs').appendFileSync('sentinel', 'invoked\\n')"] },
    }));
  }
  mkdirSync(join(root, ".paved/overrides"), { recursive: true });
  writeFileSync(join(root, ".paved/overrides/overrides.yaml"), stringify({
    apiVersion: "paved/v1", kind: "Overrides", tools: ids.map((target, index) => ({
      target, action: "select-implementation", implementation: `project.testing.binding-${index}`, owner: "team", reason: "Reviewed fixture binding",
    })),
  }));
  initializeConsumer(fixtureCore, root, "consumer");
  const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", root, "--json"], cwd: root, executablePath: join(fixtureCore, "package.json") });
  const start = async () => {
    const started = await invoke("intent", "Change behavior", "--workflow", kind, "--because", "Requested work.");
    assert.equal(started.status, "success", JSON.stringify(started));
    const id = data(started).run;
    assert.equal((await invoke("intent", "--run", id, "--advance", "--note", "Scope is clear")).status, "success");
    return id;
  };
  const plan = async (id: string) => {
    assert.equal((await invoke("intent", "--run", id, "--advance", "--note", "Inspected architecture")).status, "success");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/plan.md"), "Change feature.js.\n");
    await invoke("plan", "--run", id, "--advance", "--note", "Concrete plan", "--evidence", "docs/plan.md");
  };
  return { root, fixtureCore, invoke, start, plan };
}

async function sensitiveApprovalFixture() {
  const context = fixture("feature", "verification", "ask");
  const { root, fixtureCore, invoke, start, plan } = context;
  const toolPath = join(fixtureCore, "core/tools/testing/run.yaml");
  const tool = parse(readFileSync(toolPath, "utf8"));
  tool.inputs = [
    { name: "credential", description: "Private supplied value", type: "string", required: false, sensitive: true },
    { name: "fallback", description: "Private default value", type: "string", required: false, sensitive: true, default: "FAKE-PRIVATE-DEFAULT" },
    { name: "private-count", description: "Private count", type: "integer", required: false, sensitive: true, default: 739153 },
    { name: "private-toggle", description: "Private toggle", type: "boolean", required: false, sensitive: true, default: true },
    { name: "suite", description: "Visible choice", type: "string", required: false, default: "default-suite" },
  ];
  writeFileSync(toolPath, stringify(tool));
  const implementationPath = join(fixtureCore, "core/tool-implementations/private-check.yaml");
  writeFileSync(implementationPath, stringify({
    apiVersion: "paved/v1", kind: "ToolImplementation", id: "core.testing.private-check", tool: "core.testing.run",
    version: "0.1.0", contract: "^0.1.0", source: "core", environments: ["local"], availability: "available",
    invocation: { type: "command", executable: process.execPath, arguments: ["-e", "// FAKE-OPAQUE-ARGUMENT"] },
  }));
  const checkPath = join(root, ".paved/verification/checks/private.yaml");
  mkdirSync(dirname(checkPath), { recursive: true });
  writeFileSync(checkPath, stringify({
    apiVersion: "paved/v1", kind: "Check", id: "project.testing.private", title: "Private check", purpose: "Verify safe approval",
    type: "unit", tool: "core.testing.run", inputs: { credential: "FAKE-PRIVATE-INPUT", suite: "visible-a" },
    expected: { description: "Pass", exit_code: 0 }, timeout_seconds: 30, environment: { kinds: ["local"] },
    failure: "Failed", determinism: { class: "deterministic" }, retry: { class: "non-retryable" },
  }));
  writeFileSync(join(root, ".paved/verification/profile.yaml"), stringify({
    apiVersion: "paved/v1", kind: "VerificationProfile", checks: ["project.testing.private"],
    unavailable: [{ type: "integration", reason: "No service" }],
  }));
  initializeConsumer(fixtureCore, root, "consumer");
  const id = await start(); await plan(id); await invoke("plan", "--run", id, "--approve");
  writeFileSync(join(root, "feature.js"), "export const enabled = true;\n");
  const stopped = await invoke("execute", "--run", id, "--auto", "--note", "Implemented");
  assert.equal(data(stopped).toolApproval?.phase, "verification", JSON.stringify({ phase: data(stopped).currentPhase, diagnostics: stopped.diagnostics.map((item) => ({ code: item.code, message: item.message })) }));
  const retry = () => invoke("execute", "--run", id, "--advance");
  return { ...context, id, stopped, retry, checkPath, toolPath, implementationPath };
}

function generatedText(root: string): string {
  if (!existsSync(root)) return "";
  return readdirSync(root, { withFileTypes: true }).map((entry) => entry.isDirectory()
    ? generatedText(join(root, entry.name)) : readFileSync(join(root, entry.name), "utf8")).join("\n");
}

it("keeps sensitive Check inputs, defaults and opaque implementation arguments out of approval output and logs", async () => {
  const { root, stopped } = await sensitiveApprovalFixture();
  const serialized = JSON.stringify(stopped);
  const generated = generatedText(join(root, ".paved/generated"));
  const runs = generatedText(join(root, ".paved/generated/runs"));
  assert.ok(runs.length > 0, "the command path must produce run records to inspect");
  for (const value of ["FAKE-PRIVATE-INPUT", "FAKE-PRIVATE-DEFAULT", "FAKE-OPAQUE-ARGUMENT", "739153"]) {
    assert.equal(serialized.includes(value), false, "approval output must omit private fixture values");
    assert.equal(generated.includes(value), false, "generated logs/evidence must omit private fixture values");
    assert.equal(runs.includes(value), false, "run records must omit private fixture values");
  }
  const request = data(stopped).toolApproval! as unknown as { tools: { inputs: Record<string, unknown>; contract: { inputs: { name: string; default?: unknown }[] }; implementation: { invocation: Record<string, unknown> } }[] };
  assert.deepEqual(request.tools[0]!.inputs, { credential: "[REDACTED]", fallback: "[REDACTED]", "private-count": "[REDACTED]", "private-toggle": "[REDACTED]", suite: "visible-a" });
  assert.equal(request.tools[0]!.contract.inputs.find((input) => input.name === "fallback")?.default, undefined);
  assert.equal(request.tools[0]!.implementation.invocation.arguments, undefined);
});

it("binds approval ids to visible context without providing an oracle over hidden input/default/argument values", async () => {
  const { stopped, retry, checkPath, toolPath, implementationPath } = await sensitiveApprovalFixture();
  const { id: initial, ...safeContext } = data(stopped).toolApproval!;
  assert.equal(initial, createHash("sha256").update(JSON.stringify(safeContext)).digest("hex"), "the public digest must bind exactly the public safe request");
  const check = parse(readFileSync(checkPath, "utf8"));
  check.inputs.credential = "FAKE-REPLACEMENT-INPUT";
  writeFileSync(checkPath, stringify(check));
  const tool = parse(readFileSync(toolPath, "utf8"));
  tool.inputs.find((input: { name: string }) => input.name === "fallback").default = "FAKE-REPLACEMENT-DEFAULT";
  tool.inputs.find((input: { name: string }) => input.name === "private-count").default = 42;
  tool.inputs.find((input: { name: string }) => input.name === "private-toggle").default = false;
  writeFileSync(toolPath, stringify(tool));
  const implementation = parse(readFileSync(implementationPath, "utf8"));
  implementation.invocation.arguments = ["-e", "// FAKE-REPLACEMENT-ARGUMENT"];
  writeFileSync(implementationPath, stringify(implementation));
  assert.equal(data(await retry()).toolApproval!.id, initial, "hidden values must not enter the public digest");
  check.inputs.suite = "visible-b";
  writeFileSync(checkPath, stringify(check));
  const visibleInputRequest = data(await retry()).toolApproval!.id;
  assert.notEqual(visibleInputRequest, initial, "visible input changes must invalidate the acknowledgment");
  implementation.invocation.working_directory = "docs";
  writeFileSync(implementationPath, stringify(implementation));
  assert.notEqual(data(await retry()).toolApproval!.id, visibleInputRequest, "visible implementation changes must invalidate the acknowledgment");
});

function assertStopped(result: CommandResult, root: string, id: string, phase: string, action: string) {
  assert.equal(existsSync(join(root, "sentinel")), false, "a policy-blocked Tool must never execute");
  assert.equal(result.diagnostics[0]?.code, action === "deny" ? "PAVED_WORKFLOW_TOOL_DENIED" : "PAVED_WORKFLOW_TOOL_APPROVAL_REQUIRED", JSON.stringify(result));
  assert.equal(result.status, action === "deny" ? "failed" : "warning");
  assert.equal(data(result).phaseContext.phase, phase);
  if (action === "ask") {
    const request = data(result).toolApproval;
    assert.ok(request);
    assert.equal(request.run, id);
    assert.equal(request.phase, phase);
    assert.equal(request.tools.at(-1)?.id, "core.testing.run");
    assert.ok(request.tools[0]?.implementation.invocation);
    assert.match(data(result).nextAction, /host/i);
    assert.ok(data(result).nextAction.includes(`--host-tool-approval ${request.id}`));
    assert.equal(result.decisions?.length ?? 0, 0, "host approval is not a Paved policy decision");
  }
}

describe("policies on CLI-owned testing invocations", () => {
  for (const action of ["deny", "ask"]) {
    for (const mode of ["--auto", "--advance"]) {
      it(`${action} stops validation before the bound core.testing.run executes through ${mode}`, async () => {
        const { root, invoke, start, plan } = fixture("feature", "validation", action);
        const id = await start(); await plan(id);
        assert.equal(data(await invoke("plan", "--run", id, "--approve")).currentPhase, "implementation");
        rmSync(join(root, "sentinel"), { force: true });
        writeFileSync(join(root, "feature.js"), "export const enabled = true;\n");
        const result = await invoke("execute", "--run", id, mode, "--note", "Implemented");
        const stopped = mode === "--advance" ? await invoke("execute", "--run", id, "--advance") : result;
        assertStopped(stopped, root, id, "validation", action);
        if (action === "ask") {
          const retry = await invoke("execute", "--run", id, mode);
          assertStopped(retry, root, id, "validation", action);
          writeFileSync(join(root, "feature.js"), "export const enabled = true; // changed since approval request\n");
          const stale = await invoke("execute", "--run", id, "--advance", "--host-tool-approval", data(stopped).toolApproval!.id);
          assertStopped(stale, root, id, "validation", action);
          assert.notEqual(data(stale).toolApproval!.id, data(stopped).toolApproval!.id, "an acknowledgment must bind the current source");
          const resumed = await invoke("execute", "--run", id, "--advance", "--host-tool-approval", data(stale).toolApproval!.id);
          assert.equal(data(resumed).currentPhase, "verification", JSON.stringify(resumed));
          assert.equal(readFileSync(join(root, "sentinel"), "utf8"), "invoked\n");
        }
      });
    }
    for (const kind of ["bug", "refactor"]) it(`${action} stops ${kind} discovery before testing`, async () => {
      const { root, invoke, start } = fixture(kind, "discovery", action);
      const id = await start();
      assertStopped(await invoke("intent", "--run", id, "--advance", "--note", "Observed cause or baseline"), root, id, "discovery", action);
    });
    it(`${action} stops the optional planning baseline without swallowing policy context`, async () => {
      const { root, invoke, start, plan } = fixture("feature", "planning", action);
      const id = await start(); await plan(id);
      const stopped = await invoke("plan", "--run", id, "--approve");
      assertStopped(stopped, root, id, "planning", action);
    });
  }
  for (const action of ["deny", "ask"]) it(`${action} stops verification before its Check Tool executes`, async () => {
    const { root, fixtureCore, invoke, start, plan } = fixture("feature", "verification", action);
    // Bind an inherited Tool in Core so ordinary verification resolution selects it.
    writeFileSync(join(fixtureCore, "core/tool-implementations/policy-check.yaml"), stringify({
      apiVersion: "paved/v1", kind: "ToolImplementation", id: "core.testing.policy-check", tool: "core.testing.run", version: "0.1.0", contract: "^0.1.0", source: "core", environments: ["local"], availability: "available",
      invocation: { type: "command", executable: process.execPath, arguments: ["-e", "require('node:fs').appendFileSync('verify-sentinel', 'invoked\\n')"] },
    }));
    mkdirSync(join(root, ".paved/verification/checks"), { recursive: true });
    writeFileSync(join(root, ".paved/verification/checks/unit.yaml"), stringify({
      apiVersion: "paved/v1", kind: "Check", id: "project.testing.unit", title: "Verify behavior", purpose: "Check the feature", type: "unit", tool: "core.testing.run", expected: { description: "Pass", exit_code: 0 }, timeout_seconds: 30,
      environment: { kinds: ["local"] }, failure: "Failed", determinism: { class: "deterministic" }, retry: { class: "non-retryable" },
    }));
    writeFileSync(join(root, ".paved/verification/profile.yaml"), stringify({ apiVersion: "paved/v1", kind: "VerificationProfile", checks: ["project.testing.unit"], unavailable: [{ type: "integration", reason: "No service" }] }));
    if (action === "ask") {
      const file = join(fixtureCore, "core/workflows/feature/workflow.yaml");
      const workflow = parse(readFileSync(file, "utf8"));
      workflow.phases.find((phase: { phase: string }) => phase.phase === "validation").tool_policies = ["bounded"];
      writeFileSync(file, stringify(workflow));
    }
    initializeConsumer(fixtureCore, root, "consumer");
    const id = await start(); await plan(id);
    await invoke("plan", "--run", id, "--approve");
    writeFileSync(join(root, "feature.js"), "export const enabled = true;\n");
    rmSync(join(root, "sentinel"), { force: true });
    let stopped = await invoke("execute", "--run", id, "--auto", "--note", "Implemented");
    if (action === "ask") {
      assert.equal(data(stopped).toolApproval?.phase, "validation");
      const validationRequest = data(stopped).toolApproval!.id;
      stopped = await invoke("execute", "--run", id, "--auto", "--host-tool-approval", validationRequest);
      assert.notEqual(data(stopped).toolApproval?.id, validationRequest, "approval acknowledgment must not carry to the next automatic phase");
    }
    assert.equal(existsSync(join(root, "verify-sentinel")), false, "a verification policy must stop the actual Check Tool");
    assert.equal(stopped.diagnostics[0]?.code, action === "deny" ? "PAVED_WORKFLOW_TOOL_DENIED" : "PAVED_WORKFLOW_TOOL_APPROVAL_REQUIRED", JSON.stringify(stopped));
    assert.equal(data(stopped).phaseContext.phase, "verification");
    if (action === "ask") {
      assert.equal(data(stopped).toolApproval?.phase, "verification");
      await invoke("execute", "--run", id, "--advance", "--host-tool-approval", data(stopped).toolApproval!.id);
      assert.equal(readFileSync(join(root, "verify-sentinel"), "utf8"), "invoked\n");
    }
  });
  it("checks policy after a testing decision resolves the concrete Tool", async () => {
    const { root, invoke, start, plan } = fixture("feature", "validation", "deny", "choice");
    const id = await start(); await plan(id);
    await invoke("plan", "--run", id, "--approve");
    writeFileSync(join(root, "feature.js"), "export const enabled = true;\n");
    const pending = await invoke("execute", "--run", id, "--auto", "--note", "Implemented");
    assert.equal(pending.status, "awaiting_input", JSON.stringify(pending));
    const decision = pending.decisions![0]!;
    const chosen = decision.options.find((option) => option.label === "core.testing.other")!;
    const stopped = await invoke("execute", "--run", id, "--advance", "--answer", `${decision.id}=${chosen.id}`, "--answered-by", "owner");
    assert.equal(stopped.diagnostics[0]?.code, "PAVED_WORKFLOW_TOOL_DENIED", JSON.stringify(stopped));
    assert.equal(existsSync(join(root, "sentinel")), false);
  });
  for (const action of ["deny", "ask"]) it(`${action} preflights every resolved suite member before running any of them`, async () => {
    const { root, invoke, start, plan } = fixture("feature", "validation", action, true);
    const id = await start(); await plan(id);
    await invoke("plan", "--run", id, "--approve");
    rmSync(join(root, "sentinel"), { force: true });
    writeFileSync(join(root, "feature.js"), "export const enabled = true;\n");
    const stopped = await invoke("execute", "--run", id, "--auto", "--note", "Implemented");
    assert.equal(stopped.diagnostics[0]?.code, action === "deny" ? "PAVED_WORKFLOW_TOOL_DENIED" : "PAVED_WORKFLOW_TOOL_APPROVAL_REQUIRED", JSON.stringify(stopped));
    assert.equal(existsSync(join(root, "sentinel")), false);
    assert.match(stopped.diagnostics[0]?.message ?? "", /project.testing-detected-b.run/);
    if (action === "ask") assert.deepEqual(data(stopped).toolApproval?.tools.map((tool) => tool.id), ["project.testing-detected-a.run", "project.testing-detected-b.run"]);
  });
});


it("gives an isolated reviewer only its composed active phase and effective policies", () => {
  const { root, fixtureCore } = fixture("feature", "review", "ask");
  const file = join(fixtureCore, "core/workflows/feature/workflow.yaml");
  const workflow = parse(readFileSync(file, "utf8"));
  workflow.tool_policies = [
    { id: "review-only", allow: [], ask: ["core.repository.diff"], deny: ["core.repository.history"] },
    { id: "unrelated-secret-policy", allow: [], ask: [], deny: ["core.testing.run"] },
  ];
  const review = workflow.phases.find((p: { phase: string }) => p.phase === "review");
  review.tool_policies = ["review-only"];
  review.fragments = [{ id: "core.fragment.context-discovery", with: { subject: "the isolated review boundary" } }];
  review.tools = { optional: ["core.repository.diff"] };
  const fragmentFile = join(fixtureCore, "core/workflow-fragments/context-discovery/fragment.yaml");
  const fragment = parse(readFileSync(fragmentFile, "utf8"));
  fragment.tools = ["core.repository.files"];
  writeFileSync(fragmentFile, stringify(fragment));
  workflow.phases.find((p: { phase: string }) => p.phase === "context").tool_policies = ["unrelated-secret-policy"];
  writeFileSync(file, stringify(workflow));
  const run: Run = {
    apiVersion: "paved/v1", kind: "WorkflowRun", id: "intent-0123456789abcdef0123", workflow: { id: workflow.id, version: workflow.version },
    revision: "unversioned", started_at: new Date().toISOString(), status: "running", inputs: [], events: [], phases: [{ phase: "review", status: "running" }],
  };
  const path = writeReviewBrief(root, run, { plan_sha256: "a".repeat(64), source_sha256: "b".repeat(64), evidence_sha256: "c".repeat(64) }, fixtureCore);
  const brief = readFileSync(join(root, path), "utf8");
  const context = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(brief)?.[1] ?? "null");
  assert.ok(context, "the isolated brief must carry the resolved phase context");
  assert.equal(context.phase, "review");
  assert.ok(context.skills.includes("core.code-review.change-review"));
  assert.ok(context.skills.includes("core.discovery.context-discovery"));
  assert.deepEqual(context.tools, { required: ["core.repository.files"], optional: ["core.repository.diff"] });
  assert.deepEqual(context.toolPolicies, [{ id: "review-only", allow: [], ask: ["core.repository.diff"], deny: ["core.repository.history"] }]);
  assert.match(context.fragments[0].body, /Find the isolated review boundary/);
  assert.doesNotMatch(brief, /unrelated-secret-policy|core.testing.run/);
});
