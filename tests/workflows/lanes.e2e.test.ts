import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import type { CommandResult } from "../../cli/result.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
afterEach(cleanupTemporaryDirectories);

const TOOL = {
  apiVersion: "paved/v1", kind: "Tool", id: "project.testing.run", version: "0.1.0",
  title: "Run the test suite", purpose: "Run the project's tests; the exit code decides.", capability: "testing-run",
  safety: "safe-mutation", permissions: ["process-control"], environments: ["local"], inputs: [],
  outputs: { format: "text", description: "Test output." }, side_effects: ["process"], preconditions: [],
  idempotency: "idempotent", timeout_seconds: 30, retry: { max_attempts: 1, backoff_seconds: 0 },
  errors: ["execution-failure", "timeout"], availability: "available",
  evidence: { capture: ["revision", "environment", "timestamps", "output-digest"] }, confirmation: "none",
};

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** A committed project whose tests pass once feature.js enables the behavior, with optional flow limits. */
function project(flow?: Record<string, unknown>): string {
  const root = temporaryDirectory("paved-lanes");
  write(root, "README.md", "# Consumer\n");
  write(root, "feature.js", "export const enabled = false;\n");
  write(root, "check.mjs", 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("feature.js", "utf8").includes("true") ? 0 : 1);\n');
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
  if (flow !== undefined) write(root, ".paved/overrides/overrides.yaml", stringify({ apiVersion: "paved/v1", kind: "Overrides", flow }));
  if (!existsSync(join(root, ".git"))) git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return root;
}

const runState = (root: string, id: string) => parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as {
  status: string; classification?: { lane?: string }; phases: { phase: string; status: string }[];
};
const currentPhase = (result: CommandResult) => (result.data as { currentPhase?: string }).currentPhase;

/** A trivial run whose change is implemented and verified, waiting for its review. */
async function trivialInReview(root: string, ...extraFiles: string[]) {
  const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", root, "--json"] });
  const started = await invoke("execute", "Enable the behavior", "--workflow", "feature", "--lane", "trivial", "--because", "One flag flips in one file.");
  assert.equal(currentPhase(started), "implementation", JSON.stringify(started));
  const id = (started.data as { run: string }).run;
  write(root, "feature.js", "export const enabled = true;\n");
  for (const file of extraFiles) write(root, file, "export {};\n");
  const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Enabled the behavior");
  assert.equal(currentPhase(delivered), "review", JSON.stringify(delivered));
  return { id, invoke, delivered };
}

/** Writes a clean review for the brief Paved returned and resumes. */
async function reviewClean(root: string, id: string, invoke: (...argv: string[]) => Promise<CommandResult>, stopped: CommandResult): Promise<CommandResult> {
  const independent = (stopped.data as { review?: { independent?: { record: string; reviewed: Record<string, string>; requiredLenses: string[]; routing?: { capacity: string } } } }).review?.independent;
  if (!independent) return invoke("execute", "--run", id, "--auto");
  write(root, independent.record, stringify({
    apiVersion: "paved/v1", kind: "ChangeReviewBundle", run: id, reviewed: independent.reviewed,
    reviews: independent.requiredLenses.map((lens, index) => ({
      reviewer: { agent: `test reviewer ${index + 1}`, isolated: true, lens }, passes: ["rules", "diff", "change"], findings: [],
    })),
  }));
  return invoke("execute", "--run", id, "--auto", "--evidence", independent.record);
}

describe("lanes end to end", () => {
  it("delivers a trivial change without a plan and reviews it against the request", async () => {
    const root = project();
    // A sensitive path makes the review independent, so its brief and routing are returned.
    write(root, ".paved/review.yaml", stringify({ apiVersion: "paved/v1", kind: "ReviewPolicy", sensitive_paths: ["feature.js"] }));
    git(root, "add", ".");
    git(root, "commit", "-qm", "review policy");
    const { id, invoke, delivered } = await trivialInReview(root);
    const independent = (delivered.data as { review?: { independent?: { brief: string; routing?: { capacity: string } } } }).review?.independent;
    assert.ok(independent, JSON.stringify(delivered));
    assert.equal(independent.routing?.capacity, "economy");
    assert.match(readFileSync(join(root, independent.brief), "utf8"), /Approved plan: none; lane trivial skips planning/);
    const completed = await reviewClean(root, id, invoke, delivered);
    assert.equal(runState(root, id).status, "completed", JSON.stringify(completed));
  });

  it("refuses to complete a change to a protected path until the run is escalated and its plan approved", async () => {
    const root = project({ protected_paths: ["feature.js"] });
    const { id, invoke, delivered } = await trivialInReview(root);
    const refused = await reviewClean(root, id, invoke, delivered);
    assert.equal(refused.diagnostics[0]?.code, "PAVED_WORKFLOW_ESCALATION_REQUIRED", JSON.stringify(refused));
    assert.match(refused.diagnostics[0]?.remediation ?? "", /--lane risky --because/);
    assert.notEqual(runState(root, id).status, "completed");

    const escalated = await invoke("execute", "--run", id, "--lane", "risky", "--because", "feature.js is protected.");
    assert.equal(currentPhase(escalated), "planning", JSON.stringify(escalated));
    write(root, "docs/plan.md", "Enable the behavior in feature.js.\n");
    await invoke("plan", "--run", id, "--advance", "--note", "Plan", "--evidence", "docs/plan.md");
    const approved = await invoke("plan", "--run", id, "--approve");
    assert.equal(currentPhase(approved), "implementation", JSON.stringify(approved));
    assert.match((approved.data as { nextAction: string }).nextAction, /paved plan stops here/);

    const redelivered = await invoke("execute", "--run", id, "--auto", "--note", "Enabled the behavior");
    assert.equal(currentPhase(redelivered), "review", JSON.stringify(redelivered));
    const completed = await reviewClean(root, id, invoke, redelivered);
    assert.equal(runState(root, id).status, "completed", JSON.stringify(completed));
  });

  it("refuses a trivial run that changed more files than its limit", async () => {
    const root = project({ max_trivial_files: 1 });
    const { id, invoke, delivered } = await trivialInReview(root, "extra.js");
    const refused = await reviewClean(root, id, invoke, delivered);
    assert.equal(refused.diagnostics[0]?.code, "PAVED_WORKFLOW_ESCALATION_REQUIRED", JSON.stringify(refused));
    assert.match(refused.diagnostics[0]?.message ?? "", /at most 1 files, and this one changed 2/);
  });

  it("fails closed on a flow section that does not match the schema", async () => {
    const root = project();
    const { id, invoke, delivered } = await trivialInReview(root);
    write(root, ".paved/overrides/overrides.yaml", stringify({ apiVersion: "paved/v1", kind: "Overrides", flow: { max_trivial_files: 0 } }));
    const refused = await reviewClean(root, id, invoke, delivered);
    assert.equal(refused.diagnostics[0]?.code, "PAVED_FLOW_POLICY_INVALID", JSON.stringify(refused));
  });
});
