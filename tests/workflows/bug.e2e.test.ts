import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** A versioned project with a bug: the regression test fails until feature.js returns the right value. */
function project(): { root: string; invoke: (...argv: string[]) => Promise<CommandResult> } {
  const root = temporaryDirectory("paved-bug");
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
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return { root, invoke: (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", root, "--json"] }) };
}

const phaseOf = (result: CommandResult) => (result.data as { currentPhase?: string } | undefined)?.currentPhase;

describe("bug workflow", () => {
  it("completes on its own once the regression test failed first, recording it as the reproduction", async () => {
    const { root, invoke } = project();
    const id = ((await invoke("intent", "The behavior stays disabled", "--workflow", "bug", "--because", "The report says it is broken.")).data as { run: string }).run;
    assert.equal(phaseOf(await invoke("intent", "--run", id, "--advance", "--note", "Expected: enabled")), "discovery");
    const reproduced = await invoke("intent", "--run", id, "--advance", "--note", "feature.js hard-codes false");
    assert.equal(phaseOf(reproduced), "planning", JSON.stringify(reproduced));
    const plan = `.paved/documents/plans/${id}.md`;
    write(root, plan, "Set enabled to true in feature.js; the regression test proves it.\n");
    await invoke("plan", "--run", id, "--advance", "--note", "Plan", "--evidence", plan);
    assert.equal(phaseOf(await invoke("plan", "--run", id, "--approve")), "implementation");

    write(root, "feature.js", "export const enabled = true;\n");
    const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Enabled the behavior");
    assert.equal(phaseOf(delivered), "review", JSON.stringify(delivered));

    const run = parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as { evidence: string; events: { type: string; phase?: string; ref?: string }[] };
    const discovery = run.events.find((event) => event.phase === "discovery" && event.type === "evidence-recorded")?.ref;
    const evidence = parse(readFileSync(join(root, run.evidence), "utf8")) as { artifacts: { kind: string; source: { location: string } }[] };
    assert.equal(evidence.artifacts.find((artifact) => artifact.kind === "reproduction")?.source.location, discovery);

    const independent = (delivered.data as { review: { independent: { record: string; reviewed: Record<string, string> } } }).review.independent;
    write(root, independent.record, stringify({
      apiVersion: "paved/v1", kind: "ChangeReview", run: id, reviewer: { agent: "test reviewer", isolated: true },
      reviewed: independent.reviewed, passes: ["rules", "diff", "change"], findings: [],
    }));
    const completed = await invoke("execute", "--run", id, "--auto", "--evidence", independent.record);
    assert.equal(completed.status, "success", JSON.stringify(completed));
    assert.equal((parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as { status: string }).status, "completed");
  });
});
