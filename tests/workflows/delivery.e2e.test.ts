import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { initializeConsumer, runGenerators } from "../../cli/lib/generator-runtime.ts";
import { inspectConsumer } from "../../cli/lib/consumer-state.ts";
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
function project(versioned = true): string {
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
  if (versioned) commitAll(root, "base");
  return root;
}

function commitAll(root: string, message: string): void {
  if (!existsSync(join(root, ".git"))) git(root, "init", "-q");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message);
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
  status: string; revision: string; evidence?: string; phases: { phase: string; status: string; attempts?: number }[];
};

/** An approved run whose change is implemented, verified and recorded, waiting for its review. */
async function inReview(root: string): Promise<{ id: string; invoke: (...argv: string[]) => Promise<CommandResult>; stopped: CommandResult }> {
  const { id, invoke } = await approvedRun(root);
  write(root, "feature.js", "export const enabled = true;\n");
  const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Enabled the behavior");
  assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review", JSON.stringify(delivered));
  return { id, invoke, stopped: delivered };
}

interface Finding { severity: "blocking" | "note"; file: string; line?: number; summary: string }

/** Writes what an isolated reviewer would for the run's current state, from the review block Paved returned. */
function writeFindings(root: string, id: string, stopped: CommandResult, findings: Finding[] = [], isolated = true): string {
  const independent = (stopped.data as { review?: { independent?: { record: string; reviewed: Record<string, string> } } }).review?.independent;
  assert.ok(independent, JSON.stringify(stopped));
  write(root, independent.record, stringify({
    apiVersion: "paved/v1", kind: "ChangeReview", run: id, reviewer: { agent: "test reviewer", isolated },
    reviewed: independent.reviewed, passes: ["rules", "diff", "change"], findings,
  }));
  return independent.record;
}

async function reviewClean(root: string, id: string, invoke: (...argv: string[]) => Promise<CommandResult>, stopped: CommandResult): Promise<CommandResult> {
  return invoke("execute", "--run", id, "--auto", "--evidence", writeFindings(root, id, stopped));
}

async function amendPlan(root: string, id: string, invoke: (...argv: string[]) => Promise<CommandResult>): Promise<void> {
  write(root, "docs/plan.md", "Enable the behavior in feature.js with a boolean flag.\n");
  const amended = await invoke("plan", "--run", id, "--amend", "--note", "Use a boolean flag");
  assert.equal((amended.data as { status: string }).status, "awaiting-approval", JSON.stringify(amended));
  const approved = await invoke("plan", "--run", id, "--approve");
  assert.equal((approved.data as { status: string }).status, "running", JSON.stringify(approved));
}

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

    const completed = await reviewClean(root, id, invoke, delivered);
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
    await reviewClean(root, id, invoke, delivered);
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

  it("counts every file as changed when the run started before the repository had a commit", async () => {
    const root = project(false);
    const { id, invoke } = await approvedRun(root);
    assert.equal(runState(root, id).revision, "unversioned");
    write(root, "feature.js", "export const enabled = true;\n");
    commitAll(root, "first commit");

    const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Enabled the behavior");

    assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review", JSON.stringify(delivered));
    const evidence = parse(readFileSync(join(root, `.paved/generated/evidence/${id}-workflow.yaml`), "utf8")) as { change: { files: string[] } };
    assert.deepEqual(evidence.change.files, ["check.mjs", "docs/plan.md", "feature.js", "README.md"]);
  });

  it("sends a run in review back to implementation when an amended plan is approved, keeping earlier evidence", async () => {
    const root = project();
    const { id, invoke } = await inReview(root);
    const first = join(root, `.paved/generated/evidence/${id}-workflow.yaml`);
    const recorded = readFileSync(first, "utf8");

    await amendPlan(root, id, invoke);

    const phases = runState(root, id).phases;
    assert.equal(phases.find((phase) => phase.phase === "implementation")?.status, "running");
    for (const later of ["validation", "verification", "evidence", "review"]) {
      assert.equal(phases.find((phase) => phase.phase === later)?.status, "pending", later);
    }
    const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Implemented the amended plan");
    assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review", JSON.stringify(delivered));
    assert.equal(runState(root, id).evidence, `.paved/generated/evidence/${id}-workflow-2.yaml`);
    assert.ok(existsSync(join(root, `.paved/generated/evidence/${id}-2.diff`)));
    assert.equal(readFileSync(first, "utf8"), recorded);
    await reviewClean(root, id, invoke, delivered);
    assert.equal(runState(root, id).status, "completed");
  });

  it("names changed evidence and lets a plan amendment record it again", async () => {
    const root = project();
    const { id, invoke } = await inReview(root);
    const path = `.paved/generated/evidence/${id}-workflow.yaml`;
    writeFileSync(join(root, path), `${readFileSync(join(root, path), "utf8")}# edited\n`);

    const refused = await invoke("execute", "--run", id, "--auto", "--note", "Reviewed");
    const message = refused.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    assert.match(message, new RegExp(`${path.replaceAll(".", "\\.")} changed after it was recorded`), JSON.stringify(refused));
    assert.match(message, /--amend/);

    await amendPlan(root, id, invoke);
    const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Recorded the evidence again");
    assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review", JSON.stringify(delivered));
    await reviewClean(root, id, invoke, delivered);
    assert.equal(runState(root, id).status, "completed");
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
    assert.equal(((await invoke("execute", "--run", id, "--advance")).data as { status: string }).status, "awaiting-approval");
    assert.equal(runState(root, id).phases.find((phase) => phase.phase === "validation")?.status, "failed");
    const approved = await invoke("plan", "--run", id, "--approve");

    assert.equal((approved.data as { status: string }).status, "running", JSON.stringify(approved));
    assert.equal(runState(root, id).phases.find((phase) => phase.phase === "validation")?.status, "running");
    write(root, "feature.js", "export const enabled = true;\n");
    const passed = await invoke("execute", "--run", id, "--advance");
    assert.equal((passed.data as { currentPhase: string }).currentPhase, "verification", JSON.stringify(passed));
    assert.ok(existsSync(join(root, `.paved/approvals/${id}.json`)));
  });
});

describe("independent review", () => {
  const blocking: Finding = { severity: "blocking", file: "feature.js", line: 1, summary: "The flag is exported as a string elsewhere." };

  it("needs findings from a separate reviewer and hands it a brief with the current digests", async () => {
    const root = project();
    const { id, invoke, stopped } = await inReview(root);
    const independent = (stopped.data as { review: { independent: { brief: string; reviewed: Record<string, string> } } }).review.independent;
    const brief = readFileSync(join(root, independent.brief), "utf8");
    assert.ok(brief.includes(`.paved/generated/evidence/${id}.diff`) && brief.includes(independent.reviewed.source_sha256!), brief);
    assert.match((stopped.data as { nextAction: string }).nextAction, /subagent with its own context/);

    const refused = await invoke("execute", "--run", id, "--auto", "--note", "Looked fine to me");

    assert.equal(refused.diagnostics[0]?.code, "PAVED_REVIEW_RECORD_REQUIRED", JSON.stringify(refused));
    assert.equal(runState(root, id).status, "running");

    write(root, `.paved/generated/reviews/${id}-findings.yaml`, "findings: [unclosed\n");
    const malformed = await invoke("execute", "--run", id, "--auto", "--evidence", `.paved/generated/reviews/${id}-findings.yaml`);
    assert.equal(malformed.status, "failed", JSON.stringify(malformed));
    assert.equal(runState(root, id).phases.find((phase) => phase.phase === "review")?.status, "running");
  });

  it("refuses a review that was not isolated or that read an older state", async () => {
    const root = project();
    const { id, invoke, stopped } = await inReview(root);

    const shared = await invoke("execute", "--run", id, "--auto", "--evidence", writeFindings(root, id, stopped, [], false));
    assert.equal(shared.diagnostics[0]?.code, "PAVED_REVIEW_NOT_INDEPENDENT", JSON.stringify(shared));

    const record = writeFindings(root, id, stopped);
    write(root, "feature.js", "export const enabled = true; // changed after the review\n");
    const stale = await invoke("execute", "--run", id, "--auto", "--evidence", record);
    assert.equal(stale.diagnostics[0]?.code, "PAVED_REVIEW_STALE", JSON.stringify(stale));
    assert.match(stale.diagnostics[0]!.message, /different source/);
  });

  it("completes on accepted blocking findings and keeps them on record", async () => {
    const root = project();
    const { id, invoke, stopped } = await inReview(root);
    const record = writeFindings(root, id, stopped, [blocking, { severity: "note", file: "feature.js", summary: "Name differs from siblings." }]);

    const asked = await invoke("execute", "--run", id, "--auto", "--evidence", record);
    assert.equal(asked.status, "awaiting_input", JSON.stringify(asked));
    assert.match(asked.decisions![0]!.question, /1 blocking finding\./);
    const document = readFileSync(join(root, `.paved/generated/reviews/${id}.md`), "utf8");
    assert.match(document, /\*\*blocking\*\* `feature\.js:1`/);
    assert.match(document, /\*\*note\*\* `feature\.js`: Name differs/);

    await invoke("execute", "--run", id, "--auto", "--evidence", record, "--answer", `${asked.decisions![0]!.id}=accept`, "--answered-by", "owner@example.com");

    const state = parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as { status: string; events: { type: string; phase?: string; detail?: string }[] };
    assert.equal(state.status, "completed");
    assert.match(state.events.findLast((event) => event.phase === "review" && event.type === "evidence-recorded")!.detail!, /blocking=1 \(accepted\); notes=1/);
  });

  it("sends a fix back through implementation, verification and a new review", async () => {
    const root = project();
    const { id, invoke, stopped } = await inReview(root);
    const record = writeFindings(root, id, stopped, [blocking]);
    const asked = await invoke("execute", "--run", id, "--auto", "--evidence", record);

    const reopened = await invoke("execute", "--run", id, "--auto", "--evidence", record, "--answer", `${asked.decisions![0]!.id}=fix`, "--answered-by", "owner@example.com");

    assert.equal((reopened.data as { currentPhase: string }).currentPhase, "implementation", JSON.stringify(reopened));
    for (const later of ["validation", "verification", "evidence", "review"]) {
      assert.equal(runState(root, id).phases.find((phase) => phase.phase === later)?.status, "pending", later);
    }
    write(root, "feature.js", "export const enabled = true; // boolean\n");
    const delivered = await invoke("execute", "--run", id, "--auto", "--note", "Kept the flag a boolean");
    assert.equal((delivered.data as { currentPhase: string }).currentPhase, "review", JSON.stringify(delivered));
    const stale = await invoke("execute", "--run", id, "--auto", "--evidence", record);
    assert.equal(stale.diagnostics[0]?.code, "PAVED_REVIEW_STALE", JSON.stringify(stale));

    await reviewClean(root, id, invoke, delivered);
    assert.equal(runState(root, id).status, "completed");
  });
});

describe("starting work with execute", () => {
  it("initializes an uninitialized repository and records the request", async () => {
    const root = temporaryDirectory("paved-execute-init");
    write(root, "README.md", "# Consumer\n");
    write(root, "package.json", JSON.stringify({ name: "consumer", scripts: { test: "node check.mjs" } }));
    write(root, "check.mjs", "process.exit(0);\n");
    commitAll(root, "base");

    const started = await dispatchCli({ argv: ["execute", "Enable the behavior", "--workflow", "feature", "--because", "New behavior.", "--project", root, "--json"] });

    assert.ok(existsSync(join(root, ".paved/manifest.yaml")), JSON.stringify(started));
    const data = started.data as { run?: string; nextAction: string };
    if (started.status === "awaiting_input") assert.match(data.nextAction, /repeat paved execute "Enable the behavior"/);
    else assert.ok(data.run, JSON.stringify(started));
  });

  it("updates stale Paved state before recording the request", async () => {
    const root = project();
    runGenerators(core, root);
    write(root, "README.md", "# Consumer, changed\n");
    assert.equal(inspectConsumer({ projectRoot: root, coreRoot: core }).lifecycleState, "STALE");

    const started = await dispatchCli({ argv: ["execute", "Enable the behavior", "--workflow", "feature", "--because", "New behavior.", "--project", root, "--json"] });

    assert.equal(started.status, "success", JSON.stringify(started));
    assert.equal((started.data as { updated?: boolean }).updated, true);
    assert.ok((started.data as { run?: string }).run);
    assert.notEqual(inspectConsumer({ projectRoot: root, coreRoot: core }).lifecycleState, "STALE");
  });

  it("takes a request through intent and planning to implementation with execute alone", async () => {
    const root = project();
    const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", root, "--json"] });

    const started = await invoke("execute", "Enable the behavior", "--workflow", "feature", "--because", "New behavior.");
    const id = (started.data as { run: string }).run;
    assert.equal(started.status, "success", JSON.stringify(started));
    await invoke("execute", "--run", id, "--advance", "--note", "Scope is clear");
    await invoke("execute", "--run", id, "--advance", "--note", "Architecture inspected");
    write(root, "docs/plan.md", "Enable the behavior in feature.js.\n");
    const awaiting = await invoke("execute", "--run", id, "--advance", "--note", "Plan", "--evidence", "docs/plan.md");
    assert.equal((awaiting.data as { status: string }).status, "awaiting-approval", JSON.stringify(awaiting));
    assert.equal(runState(root, id).phases.find((phase) => phase.phase === "implementation")?.status, "pending");

    const approved = await invoke("execute", "--run", id, "--approve");

    assert.equal((approved.data as { currentPhase: string }).currentPhase, "implementation", JSON.stringify(approved));
  });

  it("refuses a request together with an existing run", async () => {
    const root = project();
    const { id, invoke } = await approvedRun(root);

    const refused = await invoke("execute", "Something else", "--run", id);

    assert.equal(refused.diagnostics[0]?.code, "PAVED_EXECUTE_REQUEST_WITH_RUN", JSON.stringify(refused));
  });

  it("approves the exact delegation graph before starting and finishing its task", async () => {
    const root = project();
    const { id, invoke } = await approvedRun(root);
    const runDoc = parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as { phases: { phase: string; gates?: { id: string; reason?: string }[] }[] };
    const planSha = /plan_sha256=([a-f0-9]{64})/.exec(runDoc.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.id === "plan-approved")?.reason ?? "")?.[1];
    assert.ok(planSha);
    write(root, ".paved/documents/delegation.yaml", stringify({
      apiVersion: "paved/v1", kind: "DelegationPlan", id, run: id, plan_sha256: planSha,
      max_concurrency: 1, tasks: [{ id: "edit", title: "Edit file", brief: "Create feature file", depends_on: [], read_paths: [], write_paths: ["feature.js"], output_contract: "Create feature.js", model_policy: { capacity: "economy", reasoning_effort: "low", rationale: "Simple bounded edit" } }],
    }));
    const registered = await invoke("delegation", "plan", "--run", id, "--file", ".paved/documents/delegation.yaml");
    assert.equal(registered.status, "success", JSON.stringify(registered));
    const premature = await invoke("delegation", "start", "--run", id, "--task", "edit", "--host", "codex", "--model", "gpt", "--effort", "low", "--isolation", "shared-workspace");
    assert.equal(premature.status, "failed");
    const approved = await invoke("delegation", "approve", "--run", id, "--approve");
    assert.equal(approved.status, "success", JSON.stringify(approved));
    const started = await invoke("delegation", "start", "--run", id, "--task", "edit", "--host", "codex", "--model", "gpt", "--effort", "low", "--isolation", "shared-workspace");
    assert.equal(started.status, "success", JSON.stringify(started));
    write(root, "feature.js", "export const enabled = true;\n");
    write(root, `.paved/generated/delegation-results/${id}/edit.md`, "Created feature.js.\n");
    const finished = await invoke("delegation", "finish", "--run", id, "--task", "edit", "--outcome", "completed", "--result", `.paved/generated/delegation-results/${id}/edit.md`, "--changed-path", "feature.js");
    assert.equal(finished.status, "success", JSON.stringify(finished));
  });

  it("keeps out-of-scope changes from being hidden by a shared-workspace retry", async () => {
    const root = project();
    const { id, invoke } = await approvedRun(root);
    const runDoc = parse(readFileSync(join(root, ".paved/generated/runs", `${id}.yaml`), "utf8")) as { phases: { phase: string; gates?: { id: string; reason?: string }[] }[] };
    const planSha = /plan_sha256=([a-f0-9]{64})/.exec(runDoc.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.id === "plan-approved")?.reason ?? "")?.[1];
    assert.ok(planSha);
    write(root, ".paved/documents/delegation.yaml", stringify({
      apiVersion: "paved/v1", kind: "DelegationPlan", id, run: id, plan_sha256: planSha,
      max_concurrency: 1, tasks: [{ id: "edit", title: "Edit file", brief: "Create feature file", depends_on: [], read_paths: [], write_paths: ["feature.js"], output_contract: "Create feature.js", model_policy: { capacity: "economy", reasoning_effort: "low", rationale: "Simple bounded edit" } }],
    }));
    await invoke("delegation", "plan", "--run", id, "--file", ".paved/documents/delegation.yaml");
    await invoke("delegation", "approve", "--run", id, "--approve");
    const start = () => invoke("delegation", "start", "--run", id, "--task", "edit", "--host", "codex", "--model", "gpt", "--effort", "low", "--isolation", "shared-workspace");
    assert.equal((await start()).status, "success");
    write(root, "outside.txt", "out-of-scope edit\n");
    const failed = await invoke("delegation", "finish", "--run", id, "--task", "edit", "--outcome", "failed");
    assert.equal(failed.status, "success", JSON.stringify(failed));
    const unsafeRetry = await start();
    assert.equal(unsafeRetry.status, "failed");
    assert.match(unsafeRetry.diagnostics[0]?.message ?? "", /out-of-scope paths remain changed/);
    rmSync(join(root, "outside.txt"));
    assert.equal((await start()).status, "success");
    write(root, "feature.js", "export const enabled = true;\n");
    write(root, `.paved/generated/delegation-results/${id}/edit.md`, "Created feature.js.\n");
    const finished = await invoke("delegation", "finish", "--run", id, "--task", "edit", "--outcome", "completed", "--result", `.paved/generated/delegation-results/${id}/edit.md`, "--changed-path", "feature.js");
    assert.equal(finished.status, "success", JSON.stringify(finished));
  });
});
