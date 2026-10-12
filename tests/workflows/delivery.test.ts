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
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** A git project whose tests pass only once feature.js enables the behavior. */
function project(): string {
  const root = temporaryDirectory("paved-delivery");
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
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base");
  return root;
}

async function approvedRun(root: string, plan = "docs/plan.md"): Promise<{ id: string; invoke: (...argv: string[]) => Promise<CommandResult> }> {
  const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", root, "--json"] });
  const id = ((await invoke("intent", "Enable the behavior", "--workflow", "feature", "--because", "New behavior.")).data as { run: string }).run;
  await invoke("intent", "--run", id, "--advance", "--note", "Scope is clear");
  await invoke("intent", "--run", id, "--advance", "--note", "Architecture inspected");
  write(root, plan, "Enable the behavior in feature.js.\n");
  await invoke("plan", "--run", id, "--advance", "--note", "Plan", "--evidence", plan);
  const approved = await invoke("plan", "--run", id, "--approve");
  assert.equal((approved.data as { currentPhase: string }).currentPhase, "implementation", JSON.stringify(approved));
  return { id, invoke };
}

const runState = (root: string, id: string) => parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as {
  status: string; evidence?: string; phases: { phase: string; status: string; attempts?: number }[];
};

describe("lifecycle remediation", () => {
  it("names paved init when work starts in an uninitialized repository", async () => {
    const root = temporaryDirectory("paved-delivery-uninitialized");
    write(root, "README.md", "# Consumer\n");

    const started = await dispatchCli({ argv: ["intent", "Enable the behavior", "--project", root, "--json"] });

    assert.equal(started.diagnostics[0]?.code, "PAVED_WORKFLOW_LIFECYCLE_BLOCKED");
    assert.equal((started.data as { remediation?: { command: string } }).remediation?.command, "paved init --json", JSON.stringify(started));
  });
});

describe("delivering an approved plan", () => {
  it("runs tests, verification and evidence on its own and stops for the review", async () => {
    const root = project();
    const { id, invoke } = await approvedRun(root);
    write(root, "feature.js", "export const enabled = true;\n");

    const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Enabled the behavior");

    assert.equal(delivered.status, "success", JSON.stringify(delivered));
    assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review");
    const evidence = parse(readFileSync(join(root, `.paved/generated/evidence/${id}-workflow.yaml`), "utf8")) as {
      change: { files: string[] }; plan: { required: string[]; evidence: string[] }; gaps?: { check_type: string; reason: string }[];
    };
    assert.deepEqual(evidence.change.files, ["docs/plan.md", "feature.js"]);
    assert.ok(evidence.plan.evidence.includes("diff"));
    assert.equal(evidence.gaps?.find((gap) => gap.check_type === "integration")?.reason, "No integration environment in this fixture.");
    assert.match(readFileSync(join(root, `.paved/generated/evidence/${id}.diff`), "utf8"), /\+export const enabled = true;/);

    const completed = await invoke("execute", "--run", id, "--auto", "--note", "Reviewed scope and evidence");
    assert.equal(runState(root, id).status, "completed", JSON.stringify(completed));
  });

  it("accepts work that already exists once the user confirms it", async () => {
    const root = project();
    write(root, "feature.js", "export const enabled = true;\n");
    git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qam", "done earlier");
    // Plans normally live under .paved/, which the change diff excludes, so nothing changes during the run.
    const { id, invoke } = await approvedRun(root, ".paved/documents/plans/plan.md");

    const asked = await invoke("execute", "--run", id, "--advance", "--note", "Already implemented");
    const decision = asked.decisions?.[0];
    assert.equal(asked.status, "awaiting_input", JSON.stringify(asked));
    const answered = await invoke("execute", "--run", id, "--advance", "--note", "Already implemented",
      "--answer", `${decision!.id}=already-done`, "--answered-by", "owner@example.com");

    assert.equal((answered.data as { currentPhase: string }).currentPhase, "validation", JSON.stringify(answered));
    const delivered = await invoke("execute", "--run", id, "--auto");
    assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review", JSON.stringify(delivered));
    const evidence = parse(readFileSync(join(root, `.paved/generated/evidence/${id}-workflow.yaml`), "utf8")) as { change: { files: string[]; summary: string } };
    assert.deepEqual(evidence.change.files, []);
    assert.match(evidence.change.summary, /already in the repository/);
    await invoke("execute", "--run", id, "--auto", "--note", "Reviewed the existing implementation");
    assert.equal(runState(root, id).status, "completed");
  });

  it("offers recovery options when a phase runs out of attempts, and abandoning frees the request", async () => {
    const root = project();
    const { id, invoke } = await approvedRun(root);
    write(root, "feature.js", "export const enabled = 'no';\n");
    await invoke("execute", "--run", id, "--advance", "--note", "Tried something");
    await invoke("execute", "--run", id, "--advance");
    await invoke("execute", "--run", id, "--advance");

    const exhausted = await invoke("execute", "--run", id, "--advance");

    assert.equal(exhausted.status, "awaiting_input", JSON.stringify(exhausted));
    assert.deepEqual(exhausted.decisions?.[0]?.options.map((option) => option.id), ["retry", "amend", "abandon"]);
    const retried = await invoke("execute", "--run", id, "--advance",
      "--answer", `${exhausted.decisions![0]!.id}=retry`, "--answered-by", "owner@example.com");
    assert.equal(runState(root, id).phases.find((phase) => phase.phase === "validation")?.attempts, 3, JSON.stringify(retried));

    const abandoned = await invoke("execute", "--run", id, "--abandon", "--note", "Changing approach");
    assert.equal(runState(root, id).status, "cancelled", JSON.stringify(abandoned));
    const restarted = await invoke("intent", "Enable the behavior", "--workflow", "feature", "--because", "New behavior.");
    assert.notEqual((restarted.data as { run: string }).run, id);
  });

  it("cancels the run when the user answers abandon, and waits for an amendment when they answer amend", async () => {
    const exhaust = async () => {
      const root = project();
      const { id, invoke } = await approvedRun(root);
      write(root, "feature.js", "export const enabled = 'no';\n");
      await invoke("execute", "--run", id, "--advance", "--note", "Tried something");
      await invoke("execute", "--run", id, "--advance");
      await invoke("execute", "--run", id, "--advance");
      const exhausted = await invoke("execute", "--run", id, "--advance");
      const answer = (value: string) => invoke("execute", "--run", id, "--advance",
        "--answer", `${exhausted.decisions![0]!.id}=${value}`, "--answered-by", "owner@example.com");
      return { root, id, answer, invoke };
    };

    const abandoning = await exhaust();
    await abandoning.answer("abandon");
    assert.equal(runState(abandoning.root, abandoning.id).status, "cancelled");

    const amending = await exhaust();
    const waiting = await amending.answer("amend");
    assert.match((waiting.data as { nextAction: string }).nextAction, /paved plan --run .* --amend/, JSON.stringify(waiting));
    const again = await amending.invoke("execute", "--run", amending.id, "--advance");
    assert.match((again.data as { nextAction: string }).nextAction, /--amend/);
    assert.equal(runState(amending.root, amending.id).phases.find((phase) => phase.phase === "validation")?.attempts, 2);
  });

  it("amends the approved plan mid-run and restarts the failed phase after approval", async () => {
    const root = project();
    const { id, invoke } = await approvedRun(root);
    write(root, "feature.js", "export const enabled = 'no';\n");
    await invoke("execute", "--run", id, "--advance", "--note", "Tried something");
    await invoke("execute", "--run", id, "--advance");
    assert.equal(runState(root, id).status, "failed");
    write(root, "docs/plan.md", "Enable the behavior in feature.js with a boolean flag.\n");

    const amended = await invoke("plan", "--run", id, "--amend", "--note", "Use a boolean flag");
    assert.equal((amended.data as { status: string }).status, "awaiting-approval", JSON.stringify(amended));
    assert.equal((await invoke("execute", "--run", id, "--advance")).diagnostics[0]?.code, "PAVED_WORKFLOW_PLAN_UNAPPROVED");
    const approved = await invoke("plan", "--run", id, "--approve");

    assert.equal((approved.data as { status: string }).status, "running", JSON.stringify(approved));
    assert.equal(runState(root, id).phases.find((phase) => phase.phase === "validation")?.status, "running");
    write(root, "feature.js", "export const enabled = true;\n");
    const passed = await invoke("execute", "--run", id, "--advance");
    assert.equal((passed.data as { currentPhase: string }).currentPhase, "verification", JSON.stringify(passed));
    assert.ok(existsSync(join(root, `.paved/approvals/${id}.json`)));
  });
});
