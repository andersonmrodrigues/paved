import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import {
  authorizeTool, buildArgv, captureToolExecution, discoverTools, resolveTool, retryDecision,
  sanitizeToolOutput, validateTool, validateToolInputs, validateToolOverrides,
  validateImplementation, validateToolResult, toEvidenceCheck,
  type ToolContract, type ToolImplementation, type ToolOverride,
} from "../../cli/lib/tools.ts";
import { at, formatErrors, schemas } from "../helpers.ts";

const tool = loadYaml(at("tests", "fixtures", "tools", "inspect-tool.yaml")) as ToolContract;
const implementation = loadYaml(at("tests", "fixtures", "tools", "inspect-implementation.yaml")) as ToolImplementation;
const copy = <T>(value: T): T => structuredClone(value);

describe("Tool capabilities", () => {
  it("validates a synthetic contract and implementation", () => {
    for (const document of [tool, implementation]) {
      const validity = schemas().validate(document);
      assert.ok(validity.valid, formatErrors(document.kind, validity.errors));
    }
    assert.deepEqual(validateTool(tool), []);
  });

  it("discovers capabilities without granting execution", () => {
    const found = discoverTools([tool], [implementation], "local", true);
    assert.equal(found[0]?.id, tool.id);
    assert.equal(found[0]?.capability, tool.capability);
    assert.equal(found[0]?.safety, "read-only");
    assert.equal(found[0]?.available, true);
    assert.equal("command" in found[0]!, false);
    assert.equal(discoverTools([tool], [], "local", true)[0]?.available, false);
  });

  it("resolves compatible implementations and blocks incompatible versions", () => {
    assert.equal(resolveTool(tool.id, [tool], [implementation], "local", undefined, true).status, "resolved");
    const bad = copy(implementation);
    bad.contract = "^0.2.0";
    assert.match(resolveTool(tool.id, [tool], [bad], "local", undefined, true).reason ?? "", /compatible/);
  });

  it("rejects an implementation that exceeds contract limits", () => {
    const bad = copy(implementation);
    bad.environments.push("production");
    bad.invocation.timeout_seconds = tool.timeout_seconds + 1;
    assert.match(validateImplementation(bad, tool, true).join("\n"), /outside/);
    assert.match(validateImplementation(bad, tool, true).join("\n"), /timeout/);
    bad.invocation.input_bindings = [{input: "unknown"}];
    assert.match(validateImplementation(bad, tool, true).join("\n"), /unknown input/);
    bad.invocation.input_bindings = [{input: "path"}, {input: "path"}];
    assert.match(validateImplementation(bad, tool, true).join("\n"), /more than once/);
    bad.invocation.type = "command";
    bad.invocation.executable = "synthetic-runner";
    bad.invocation.input_bindings = [];
    assert.match(validateImplementation(bad, tool, true).join("\n"), /required input path/);
  });

  it("requires an explicit override to use a project implementation of a Core capability", () => {
    const inherited = copy(tool);
    inherited.id = "core.synthetic.inspect";
    const project = copy(implementation);
    project.tool = inherited.id;
    assert.equal(resolveTool(inherited.id, [inherited], [project], "local", undefined, true).status, "blocked");
    const override: ToolOverride = {
      target: inherited.id, action: "select-implementation", implementation: project.id,
      owner: "team", reason: "Synthetic binding",
    };
    assert.equal(resolveTool(inherited.id, [inherited], [project], "local", override, true).status, "resolved");
  });

  it("rejects overrides that widen a Tool's environment or timeout", () => {
    assert.match(validateToolOverrides([{
      target: tool.id, action: "restrict", allowed_environments: ["production"],
      owner: "team", reason: "Invalid widening",
    }], [tool]).join("\n"), /outside/);
    assert.match(validateToolOverrides([{
      target: tool.id, action: "restrict", timeout_seconds: tool.timeout_seconds + 1,
      owner: "team", reason: "Invalid widening",
    }], [tool]).join("\n"), /exceeds/);
  });

  it("checks inputs, permissions, preconditions and environment before execution", () => {
    assert.deepEqual(validateToolInputs(tool, {path: "src/file"}).problems, []);
    assert.match(validateToolInputs(tool, {path: "../secret"}).problems.join("\n"), /path/);
    assert.match(validateToolInputs(tool, {path: "src/file", extra: "x"}).problems.join("\n"), /unknown/);
    const allowed = authorizeTool(tool, {
      environment: "local", permissions: ["repository-read"], preconditions: {repository: true},
    });
    assert.equal(allowed.allowed, true);
    const denied = authorizeTool(tool, {
      environment: "local", permissions: [], preconditions: {repository: false},
    });
    assert.equal(denied.allowed, false);
    assert.match(denied.reasons.join("\n"), /permission/);
    assert.match(denied.reasons.join("\n"), /precondition/);
    assert.equal(authorizeTool(tool, {
      environment: "production", permissions: ["repository-read"], preconditions: {repository: true},
    }).allowed, false);
  });

  it("builds an argv vector from validated inputs without shell interpolation", () => {
    const command = copy(implementation);
    command.invocation = {type: "command", executable: "git", arguments: ["diff"], input_bindings: [{input: "path", flag: "--"}]};
    assert.deepEqual(buildArgv(tool, command, {path: "src/file"}), {executable: "git", argv: ["diff", "--", "src/file"]});
    assert.throws(() => buildArgv(tool, command, {path: "../secret"}), /path/);
  });

  it("requires independent approval for destructive and high-impact Tools", () => {
    for (const safety of ["destructive", "high-impact"] as const) {
      const dangerous = copy(tool);
      dangerous.safety = safety;
      dangerous.confirmation = "required";
      dangerous.permissions = ["database-write"];
      dangerous.side_effects = ["database"];
      dangerous.environments = ["production"];
      assert.equal(authorizeTool(dangerous, {
        environment: "production", permissions: ["database-write"], preconditions: {repository: true},
      }).allowed, false);
      assert.equal(authorizeTool(dangerous, {
        environment: "production", permissions: ["database-write"], preconditions: {repository: true},
        approval: {approved_by: "human-owner"},
      }).allowed, true);
      assert.equal(authorizeTool(dangerous, {
        environment: "production", permissions: ["database-write"], preconditions: {repository: true},
        approval: {approved_by: "agent"},
      }).allowed, false);
    }
  });

  it("does not retry dangerous or non-idempotent operations", () => {
    assert.equal(retryDecision(tool, "transient-failure", 1).retry, true);
    const dangerous = copy(tool);
    dangerous.safety = "high-impact";
    assert.equal(retryDecision(dangerous, "transient-failure", 1).retry, false);
    dangerous.safety = "safe-mutation";
    dangerous.idempotency = "unknown";
    assert.equal(retryDecision(dangerous, "transient-failure", 1).retry, false);
  });

  it("redacts sensitive keys and values before evidence capture", () => {
    const sanitized = sanitizeToolOutput(
      {message: "token=abc123", access_token: "abc123", count: 2},
      ["abc123"],
    ) as Record<string, unknown>;
    assert.equal(sanitized.count, 2);
    assert.equal(sanitized.access_token, "[REDACTED]");
    assert.equal(sanitized.message, "token=[REDACTED]");
    assert.equal(sanitizeToolOutput("api_key=abc123"), "api_key=[REDACTED]");
  });

  it("rejects malformed structured output and records it as a failure", () => {
    assert.match(validateToolResult(tool, {other: 2}).join("\n"), /count/);
    const record = captureToolExecution({
      tool, implementation, environment: "local", revision: "abc123",
      runtime_version: "synthetic/1",
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
      status: "succeeded", output: {other: 2}, inputs: {path: "src/file"},
    });
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "malformed-output");
    assert.match(record.errors.join("\n"), /count/);
  });

  it("captures a structured result bound to revision and implementation", () => {
    const record = captureToolExecution({
      tool, implementation, environment: "local", revision: "abc123",
      runtime_version: "synthetic/1",
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
      status: "succeeded", output: {count: 2}, inputs: {path: "src/file"},
      exit_code: 0,
    });
    assert.equal(record.tool.id, tool.id);
    assert.equal(record.tool.version, tool.version);
    assert.equal(record.tool.implementation_version, implementation.version);
    assert.equal(record.execution.revision, "abc123");
    assert.equal(record.execution.recorded_by, "agent");
    assert.equal(record.execution.environment.kind, "local");
    assert.equal(record.execution.environment.facts["tool-runtime-version"], "synthetic/1");
    assert.deepEqual(record.output, {count: 2});
    assert.ok(record.input_sha256);
    assert.ok(record.output_sha256);
    const check = toEvidenceCheck(record, {id: "project.synthetic.check", type: "configuration", tool: tool.id, expected: {exit_code: 0}}, "synthetic-run");
    assert.equal(check.status, "passed");
    assert.equal(check.execution.revision, "abc123");
    assert.equal(check.tool.version, tool.version);
    const evidence = loadYaml(at("core", "templates", "evidence.yaml")) as { checks: unknown[] } & Record<string, unknown>;
    evidence.checks[0] = check;
    const validity = schemas().validate(evidence);
    assert.ok(validity.valid, formatErrors("Tool CheckResult", validity.errors));
  });

  it("does not turn execution success into a passed Check without a matching observation", () => {
    const record = captureToolExecution({
      tool, implementation, environment: "local", revision: "abc123", runtime_version: "synthetic/1",
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
      status: "succeeded", output: {count: 2}, inputs: {path: "src/file"},
    });
    const check = toEvidenceCheck(record, {id: "project.synthetic.check", type: "configuration", tool: tool.id, expected: {exit_code: 0}}, "synthetic-run");
    assert.equal(check.status, "inconclusive");
    const mismatch = captureToolExecution({
      tool, implementation, environment: "local", revision: "abc123", runtime_version: "synthetic/1",
      started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
      status: "succeeded", exit_code: 1, output: {count: 2}, inputs: {path: "src/file"},
    });
    assert.equal(toEvidenceCheck(mismatch, {id: "project.synthetic.check", type: "configuration", tool: tool.id, expected: {exit_code: 0}}, "synthetic-run").status, "failed");
  });

  it("requires a run URL for a CI-recorded result", () => {
    assert.throws(() => captureToolExecution({
      tool, implementation, environment: "ci", revision: "abc123", runtime_version: "synthetic/1",
      recorded_by: "ci", started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z",
      status: "succeeded", output: {count: 2}, inputs: {path: "src/file"},
    }), /run_url/);
  });
});
