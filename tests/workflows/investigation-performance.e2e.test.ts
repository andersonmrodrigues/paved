import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { assessAnswer } from "../../cli/lib/workflow-gates/investigation.ts";
import { compareSamples } from "../../cli/lib/workflow-gates/performance.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import type { CommandResult } from "../../cli/result.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
afterEach(cleanupTemporaryDirectories);

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const TOOL = {
  apiVersion: "paved/v1", kind: "Tool", id: "project.testing.run", version: "0.1.0",
  title: "Run the test suite", purpose: "Run the project's tests; the exit code decides.", capability: "testing-run",
  safety: "safe-mutation", permissions: ["process-control"], environments: ["local"], inputs: [],
  outputs: { format: "text", description: "Test output." }, side_effects: ["process"], preconditions: [],
  idempotency: "idempotent", timeout_seconds: 30, retry: { max_attempts: 1, backoff_seconds: 0 },
  errors: ["execution-failure", "timeout"], availability: "available",
  evidence: { capture: ["revision", "environment", "timestamps", "output-digest"] }, confirmation: "none",
};

/** A versioned project with a slow function and a test that passes as long as it returns the right value. */
function project(): { root: string; invoke: (...argv: string[]) => Promise<CommandResult> } {
  const root = temporaryDirectory("paved-investigate");
  write(root, "README.md", "# Consumer\n");
  write(root, "sum.js", "export function sum(values) {\n  let total = 0;\n  for (const value of values) total = total + value;\n  return total;\n}\n");
  write(root, "check.mjs", 'import { sum } from "./sum.js";\nprocess.exit(sum([1, 2, 3]) === 6 ? 0 : 1);\n');
  initializeConsumer(core, root, "consumer");
  write(root, ".paved/tools/testing/run.yaml", stringify(TOOL));
  write(root, ".paved/tool-implementations/testing/run.yaml", stringify({
    apiVersion: "paved/v1", kind: "ToolImplementation", id: "project.testing.run", tool: "project.testing.run",
    version: "0.1.0", contract: "^0.1.0", source: "project", environments: ["local"],
    invocation: { type: "command", executable: process.execPath, arguments: ["check.mjs"], timeout_seconds: 30 }, availability: "available",
  }));
  write(root, ".paved/verification/checks/unit.yaml", stringify({
    apiVersion: "paved/v1", kind: "Check", id: "project.testing.unit", title: "Tests pass", purpose: "The suite passes.",
    type: "unit", tool: "project.testing.run", expected: { description: "Exit 0.", exit_code: 0 }, timeout_seconds: 30,
    environment: { kinds: ["local"] }, failure: "A test failed.", determinism: { class: "deterministic" }, retry: { class: "non-retryable" },
  }));
  write(root, ".paved/verification/profile.yaml", stringify({
    apiVersion: "paved/v1", kind: "VerificationProfile", checks: ["project.testing.unit"],
    unavailable: [{ type: "integration", reason: "No integration environment in this fixture." }],
  }));
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return { root, invoke: (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", root, "--json"] }) };
}

const runState = (root: string, id: string) => parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as {
  status: string; evidence?: string; phases: { phase: string; status: string; gates?: { id: string; status: string }[] }[];
};
const runOf = (result: CommandResult) => (result.data as { run: string }).run;
const phaseOf = (result: CommandResult) => (result.data as { currentPhase?: string } | undefined)?.currentPhase;

function answer(root: string, id: string, claims: string[]): string {
  const path = `.paved/documents/research/${id}.md`;
  write(root, path, ["# Why is sum slow?", "", "## Answer", "", "It adds one value at a time.", "", "## Claims", "",
    ...claims, "", "## Recommendation", "", "No change is needed; if one is wanted, start a performance run.", ""].join("\n"));
  return path;
}

describe("investigation workflow", () => {
  it("completes read-only with a cited answer and no plan approval", async () => {
    const { root, invoke } = project();
    const commit = git(root, "rev-parse", "--short", "HEAD");
    const id = runOf(await invoke("intent", "Why is sum slow?", "--workflow", "investigation", "--because", "The user asks a question and wants no change."));
    assert.equal(phaseOf(await invoke("intent", "--run", id, "--advance", "--note", "The question is clear")), "discovery");
    const path = answer(root, id, [
      "- [observed] The loop adds one value per iteration `sum.js:3`.",
      `- [inferred] It has not changed since it was written \`commit ${commit}\`.`,
      "- [unknown] Whether callers pass large arrays.",
    ]);
    const discovered = await invoke("intent", "--run", id, "--advance", "--evidence", path, "--note", "It is linear");
    assert.equal(phaseOf(discovered), "verification", JSON.stringify(discovered));
    assert.match((discovered.data as { nextAction?: string }).nextAction ?? "", /paved execute --run .* --auto/);
    const done = await invoke("execute", "--run", id, "--auto");
    assert.equal(done.status, "success", JSON.stringify(done));
    const run = runState(root, id);
    assert.equal(run.status, "completed", JSON.stringify(done));
    assert.equal(run.evidence, path);
    assert.ok(run.phases.every((phase) => phase.phase !== "planning" && phase.phase !== "implementation"));
    assert.match((done.data as { message?: string }).message ?? JSON.stringify(done), /Investigation complete/);
  });

  it("blocks an answer whose citations do not resolve", async () => {
    const { root, invoke } = project();
    const id = runOf(await invoke("intent", "Why is sum slow?", "--workflow", "investigation", "--because", "A question."));
    await invoke("intent", "--run", id, "--advance", "--note", "Clear");
    const path = answer(root, id, ["- [observed] The loop is on line 40 `sum.js:40`.", "- [inferred] It is slow."]);
    const refused = await invoke("intent", "--run", id, "--advance", "--evidence", path, "--note", "x");
    assert.equal(refused.diagnostics[0]?.code, "PAVED_INVESTIGATION_ANSWER_INVALID", JSON.stringify(refused));
    assert.match(refused.diagnostics[0]?.message ?? "", /outside the file's 6 lines/);
    assert.match(refused.diagnostics[0]?.message ?? "", /claim 2 is inferred but cites no/);
  });

  it("refuses to continue once a source file changed during the run", async () => {
    const { root, invoke } = project();
    const id = runOf(await invoke("intent", "Why is sum slow?", "--workflow", "investigation", "--because", "A question."));
    await invoke("intent", "--run", id, "--advance", "--note", "Clear");
    const path = answer(root, id, ["- [observed] The loop adds one value per iteration `sum.js:3`."]);
    await invoke("intent", "--run", id, "--advance", "--evidence", path, "--note", "Linear");
    write(root, "sum.js", "export const sum = (values) => values.reduce((a, b) => a + b, 0);\n");
    const refused = await invoke("execute", "--run", id, "--auto");
    assert.equal(refused.diagnostics[0]?.code, "PAVED_INVESTIGATION_SOURCE_CHANGED", JSON.stringify(refused));
    assert.notEqual(runState(root, id).status, "completed");
  });

  it("parses labels and citation kinds without running commands", () => {
    const { root } = project();
    const text = ["## Answer", "x", "## Claims", "- [observed] Ran the suite `$ npm test`.", "- plain claim", "- [inferred] `sum.js:1`",
      "## Recommendation", "none"].join("\n");
    const { problems, claims } = assessAnswer(root, text);
    assert.deepEqual(claims.map((claim) => claim.label), ["observed", "inferred"]);
    assert.deepEqual(problems, ["claim 2 does not start with [observed], [inferred] or [unknown]", "claim 3 states nothing besides its sources"]);
  });
});

function measurement(root: string, id: string, stage: "baseline" | "after", samples: number[], method = "node bench.mjs"): string {
  const path = `.paved/generated/measurements/${id}-${stage}.yaml`;
  write(root, path, stringify({
    apiVersion: "paved/v1", kind: "PerformanceMeasurement", run: id, stage,
    metric: { name: "sum of 1e6 values", unit: "ms", direction: "lower-is-better" },
    method: { command: method, workload: "1e6 integers", environment: "laptop, on AC power", warmup: "2 discarded runs" },
    samples, limits: "One machine; background load not controlled.",
    ...(stage === "baseline" ? { hypothesis: "The per-item addition dominates; a typed array sum halves it." } : {}),
  }));
  return path;
}

async function planned(root: string, invoke: (...argv: string[]) => Promise<CommandResult>): Promise<string> {
  const id = runOf(await invoke("intent", "Make sum faster", "--workflow", "performance", "--because", "The user measured it as slow."));
  await invoke("intent", "--run", id, "--advance", "--note", "Latency of sum on 1e6 values");
  const baseline = await invoke("intent", "--run", id, "--advance", "--evidence", measurement(root, id, "baseline", [412, 405, 418, 409, 411]), "--note", "Per-item addition");
  assert.equal(phaseOf(baseline), "planning", JSON.stringify(baseline));
  write(root, "docs/plan.md", "Sum with a typed array.\n");
  await invoke("plan", "--run", id, "--advance", "--note", "Plan", "--evidence", "docs/plan.md");
  const approved = await invoke("plan", "--run", id, "--approve");
  assert.equal(phaseOf(approved), "implementation", JSON.stringify(approved));
  write(root, "sum.js", "export function sum(values) {\n  return Float64Array.from(values).reduce((a, b) => a + b, 0);\n}\n");
  return id;
}

describe("performance workflow", () => {
  it("refuses to leave discovery without a baseline", async () => {
    const { invoke } = project();
    const id = runOf(await invoke("intent", "Make sum faster", "--workflow", "performance", "--because", "Measured slowness."));
    await invoke("intent", "--run", id, "--advance", "--note", "Latency");
    const refused = await invoke("intent", "--run", id, "--advance", "--note", "I think it is the loop");
    assert.equal(refused.diagnostics[0]?.code, "PAVED_PERFORMANCE_BASELINE_REQUIRED", JSON.stringify(refused));
  });

  it("refuses a baseline taken after the code changed", async () => {
    const { root, invoke } = project();
    const id = runOf(await invoke("intent", "Make sum faster", "--workflow", "performance", "--because", "Measured slowness."));
    await invoke("intent", "--run", id, "--advance", "--note", "Latency");
    write(root, "sum.js", "export const sum = (values) => values.reduce((a, b) => a + b, 0);\n");
    const refused = await invoke("intent", "--run", id, "--advance", "--evidence", measurement(root, id, "baseline", [1, 2, 3]), "--note", "x");
    assert.equal(refused.diagnostics[0]?.code, "PAVED_PERFORMANCE_BASELINE_LATE", JSON.stringify(refused));
  });

  it("refuses an after measurement taken with another method", async () => {
    const { root, invoke } = project();
    const id = await planned(root, invoke);
    const refused = await invoke("execute", "--run", id, "--auto", "--evidence", measurement(root, id, "after", [220, 221, 222], "node other.mjs"), "--note", "Typed array");
    assert.equal(refused.diagnostics[0]?.code, "PAVED_PERFORMANCE_METHOD_CHANGED", JSON.stringify(refused));
  });

  it("fails an improvement that stays within the noise", async () => {
    const { root, invoke } = project();
    const id = await planned(root, invoke);
    const result = await invoke("execute", "--run", id, "--auto", "--evidence", measurement(root, id, "after", [404, 410, 415, 408, 412]), "--note", "Typed array");
    assert.match(JSON.stringify(result), /within the noise of the baseline/);
    assert.notEqual(runState(root, id).phases.find((phase) => phase.phase === "implementation")?.status, "completed");
  });

  it("accepts an improvement that clears the baseline's spread and verifies the measured code", async () => {
    const { root, invoke } = project();
    const id = await planned(root, invoke);
    const delivered = await invoke("execute", "--run", id, "--auto", "--evidence", measurement(root, id, "after", [221, 230, 219, 225, 224]), "--note", "Typed array");
    assert.equal(phaseOf(delivered), "review", JSON.stringify(delivered));
    const state = runState(root, id);
    assert.deepEqual(state.phases.find((phase) => phase.phase === "implementation")?.gates?.map((gate) => gate.id), ["after-measured", "improvement-supported"]);
    assert.equal(state.phases.find((phase) => phase.phase === "verification")?.status, "completed");
  });

  it("reopens implementation when the code changes after it was measured", async () => {
    const { root, invoke } = project();
    const id = await planned(root, invoke);
    write(root, "sum.js", "export function sum() {\n  return 0;\n}\n");
    const failed = await invoke("execute", "--run", id, "--auto", "--evidence", measurement(root, id, "after", [21, 23, 22, 22, 24]), "--note", "Broken shortcut");
    assert.notEqual(phaseOf(failed), "review", JSON.stringify(failed));
    write(root, "sum.js", "export function sum(values) {\n  return Float64Array.from(values).reduce((a, b) => a + b, 0);\n}\n");
    const reopened = await invoke("execute", "--run", id, "--auto");
    assert.equal(phaseOf(reopened), "implementation", JSON.stringify(reopened));
    assert.match(JSON.stringify(reopened), /Measure the current code/);
    const tampered = measurement(root, id, "baseline", [1, 1, 1]);
    const refused = await invoke("execute", "--run", id, "--auto", "--evidence", measurement(root, id, "after", [221, 230, 219, 225, 224]), "--note", "Typed array");
    assert.equal(refused.diagnostics[0]?.code, "PAVED_PERFORMANCE_MEASUREMENT_CHANGED", `${tampered} ${JSON.stringify(refused)}`);
  });

  it("compares sample sets by their interquartile ranges", () => {
    assert.equal(compareSamples([100, 101, 102, 103], [50, 51, 52, 53], "lower-is-better").verdict, "improved");
    assert.equal(compareSamples([100, 110, 90, 105], [95, 108, 99, 101], "lower-is-better").verdict, "within-noise");
    assert.equal(compareSamples([100, 101, 102, 103], [150, 151, 152, 153], "lower-is-better").verdict, "regressed");
    assert.equal(compareSamples([100, 101, 102, 103], [150, 151, 152, 153], "higher-is-better").verdict, "improved");
    assert.equal(compareSamples([0, 0, 0], [0, 0, 0], "lower-is-better").changePercent, undefined);
  });
});
