import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { loadContract, type Run } from "../../cli/lib/workflow-runs.ts";
import { assessRun, effectiveRouting, type WorkflowRunRecord } from "../../cli/lib/workflows.ts";
import { flowViolation } from "../../cli/lib/flow-guards.ts";
import type { CommandResult } from "../../cli/result.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let project = "";
const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", project, "--json"], cwd: project, executablePath: join(core, "cli", "index.ts") });
const runOf = (result: CommandResult) => (result.data as { run: string }).run;
const readRunFile = (id: string) => parse(readFileSync(join(project, ".paved/generated/runs", `${id}.yaml`), "utf8")) as Run;
const statuses = (run: Run) => Object.fromEntries(run.phases.map((phase) => [phase.phase, phase.status]));
const code = (result: CommandResult) => result.diagnostics[0]?.code;
const data = (result: CommandResult) => result.data as { currentPhase?: string; nextAction: string; lane?: string; routing?: { phase: string; capacity: string; reasoning_effort: string } };

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "paved-lanes-"));
  writeFileSync(join(project, "README.md"), "# Consumer\n");
  initializeConsumer(core, project, "consumer");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("lane classification", () => {
  it("is chosen with the workflow and needs its evidence", async () => {
    const withoutWorkflow = await invoke("intent", "Rename a label", "--lane", "trivial", "--because", "One string changes.");
    assert.equal(code(withoutWorkflow), "PAVED_INTENT_FLAGS_INVALID", JSON.stringify(withoutWorkflow));
    const withoutEvidence = await invoke("intent", "Rename a label", "--workflow", "feature", "--lane", "trivial");
    assert.equal(code(withoutEvidence), "PAVED_INTENT_RATIONALE_REQUIRED", JSON.stringify(withoutEvidence));
    const unknown = await invoke("intent", "Rename a label", "--workflow", "feature", "--lane", "tiny", "--because", "One string.");
    assert.equal(unknown.status, "failed");
    assert.equal(unknown.diagnostics[0]?.category, "usage");
  });

  it("records the lane, skips what it skips and stops intent at classification", async () => {
    const started = await invoke("intent", "Rename a label", "--workflow", "feature", "--lane", "trivial", "--because", "One string changes in one file.");
    assert.equal(started.status, "success", JSON.stringify(started));
    const run = readRunFile(runOf(started));
    assert.equal(run.classification?.lane, "trivial");
    assert.equal(run.classification?.lane_because, "One string changes in one file.");
    assert.deepEqual(statuses(run), {
      context: "skipped", discovery: "skipped", planning: "skipped", implementation: "running",
      validation: "pending", verification: "pending", evidence: "pending", review: "pending", completion: "pending",
    });
    const context = run.phases.find((phase) => phase.phase === "context");
    assert.equal(context?.skipped_in_lane, "trivial");
    assert.equal(context?.skip_reason, "Lane trivial: One string changes in one file.");
    assert.equal(run.events.filter((event) => event.type === "phase-skipped").length, 3);
    assert.match(data(started).nextAction, /paved intent stops here/);
    const document = readFileSync(join(project, `.paved/documents/intents/${run.id}.md`), "utf8");
    assert.match(document, /- Lane: `trivial`/);
    assert.match(document, /- Skipped by the lane: `context`, `discovery`, `planning`/);
  });

  it("keeps every phase when no lane is chosen", async () => {
    const started = await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "A new export format is requested.");
    const run = readRunFile(runOf(started));
    assert.equal(run.classification?.lane, undefined);
    assert.equal(statuses(run).context, "running");
    assert.ok(run.phases.every((phase) => phase.status !== "skipped"));
    assert.match(readFileSync(join(project, `.paved/documents/intents/${run.id}.md`), "utf8"), /- Lane: none chosen; every phase runs\./);
  });

  it("runs context and discovery in a standard bug run", async () => {
    const started = await invoke("intent", "Fix the export crash", "--workflow", "bug", "--lane", "standard", "--because", "A reported crash with a known reproduction.");
    const run = readRunFile(runOf(started));
    assert.deepEqual([statuses(run).context, statuses(run).discovery, statuses(run).planning], ["running", "pending", "pending"]);
  });
});

describe("lane skip validation", () => {
  const contract = loadContract(core, "core.feature");
  // The given phases first, then the rest of the workflow still pending.
  const record = (lane: "trivial" | "standard" | "risky", phases: WorkflowRunRecord["phases"]): WorkflowRunRecord => ({
    workflow: { id: contract.id, version: contract.version }, classification: { lane }, status: "running",
    inputs: [{ id: "request", value: "Rename a label", source: "human" }],
    phases: [...phases, ...contract.phases.slice(phases.length).map((phase) => ({ phase: phase.phase, status: "pending" }))], events: [],
  } as unknown as WorkflowRunRecord);
  const done = (phase: string) => ({ phase, status: "completed", attempts: 1 });
  const skipped = (phase: string, lane: "trivial" | "standard") => ({ phase, status: "skipped", skip_reason: `Lane ${lane}: small.`, skipped_in_lane: lane });

  it("accepts a skip the lane declares and refuses one it does not", () => {
    assert.deepEqual(assessRun(record("trivial", [skipped("context", "trivial"), skipped("discovery", "trivial"), skipped("planning", "trivial"), { phase: "implementation", status: "running", attempts: 1 }]), contract), []);
    const problems = assessRun(record("standard", [skipped("context", "standard"), { phase: "discovery", status: "running", attempts: 1 }]), contract);
    assert.ok(problems.some((problem) => problem.includes("phase context was skipped in lane standard, which does not skip it")), problems.join("\n"));
  });

  it("refuses a risky run that keeps planning skipped", () => {
    const problems = assessRun(record("risky", [done("context"), done("discovery"), skipped("planning", "standard"), { phase: "implementation", status: "running", attempts: 1 }]), contract);
    assert.ok(problems.some((problem) => problem.includes("phase planning needs a human approval in a risky run")), problems.join("\n"));
  });
});

describe("routing by lane", () => {
  it("overrides capacity and effort for the lane and keeps the mode", () => {
    const contract = loadContract(core, "core.feature");
    const review = contract.phases.find((phase) => phase.phase === "review")!;
    assert.deepEqual([effectiveRouting(review, "trivial")?.mode, effectiveRouting(review, "trivial")?.capacity, effectiveRouting(review, "trivial")?.reasoning_effort], ["subagent", "economy", "low"]);
    assert.deepEqual([effectiveRouting(review, "risky")?.capacity, effectiveRouting(review, "risky")?.reasoning_effort], ["frontier", "high"]);
    assert.deepEqual(effectiveRouting(review, undefined), review.routing);
    assert.deepEqual(effectiveRouting(review, "standard"), review.routing);
  });

  it("returns the lane's routing for the active phase", async () => {
    const started = await invoke("execute", "Rename a label", "--workflow", "feature", "--lane", "trivial", "--because", "One string changes in one file.");
    assert.equal(started.status, "success", JSON.stringify(started));
    assert.equal(data(started).currentPhase, "implementation");
    assert.equal(data(started).lane, "trivial");
    assert.deepEqual(data(started).routing, { phase: "implementation", mode: "primary", capacity: "economy", reasoning_effort: "low",
      rationale: "A trivial change is small and local; an economy model makes it." });
  });
});

describe("entry points", () => {
  it("plan starts a request without a prior intent", async () => {
    const started = await invoke("plan", "Add CSV export", "--workflow", "feature", "--because", "A new export format is requested.");
    assert.equal(started.status, "success", JSON.stringify(started));
    assert.equal(readRunFile(runOf(started)).workflow?.id, "core.feature");
    assert.match(data(started).nextAction, /paved plan stops once the plan is approved/);
  });

  it("plan refuses a lane that skips planning and a workflow without one", async () => {
    const trivial = await invoke("plan", "Rename a label", "--workflow", "feature", "--lane", "trivial", "--because", "One string.");
    assert.equal(code(trivial), "PAVED_LANE_SKIPS_PLANNING", JSON.stringify(trivial));
    const investigation = await invoke("plan", "Where is export handled?", "--workflow", "investigation", "--because", "A question about the code.");
    assert.equal(code(investigation), "PAVED_PLAN_UNAVAILABLE", JSON.stringify(investigation));
  });

  it("execute with a trivial lane goes straight to implementation", async () => {
    const started = await invoke("execute", "Rename a label", "--workflow", "feature", "--lane", "trivial", "--because", "One string changes in one file.");
    assert.equal(data(started).currentPhase, "implementation", JSON.stringify(started));
    assert.match(data(started).nextAction, /Lane trivial skips planning/);
    assert.equal(statuses(readRunFile(runOf(started))).planning, "skipped");
  });
});

describe("escalation", () => {
  it("reopens skipped planning when a run moves to risky", async () => {
    const id = runOf(await invoke("execute", "Rename a label", "--workflow", "feature", "--lane", "trivial", "--because", "One string changes in one file."));
    const escalated = await invoke("execute", "--run", id, "--lane", "risky", "--because", "The label is part of the billing contract.");
    assert.equal(escalated.status, "success", JSON.stringify(escalated));
    const run = readRunFile(id);
    assert.equal(run.classification?.lane, "risky");
    assert.equal(run.classification?.lane_because, "The label is part of the billing contract.");
    assert.deepEqual([statuses(run).context, statuses(run).planning, statuses(run).implementation], ["skipped", "running", "pending"]);
    assert.ok(run.events.some((event) => event.type === "lane-escalated" && event.detail?.startsWith("from=trivial")));
    assert.equal(data(escalated).currentPhase, "planning");
    assert.match(readFileSync(join(project, `.paved/documents/intents/${id}.md`), "utf8"), /- Lane because: The label is part of the billing contract\./);

    const again = await invoke("execute", "--run", id, "--lane", "risky", "--because", "Still risky.");
    assert.equal(code(again), "PAVED_LANE_ESCALATION_INVALID", JSON.stringify(again));
  });

  it("only escalates to risky, with evidence", async () => {
    const id = runOf(await invoke("execute", "Rename a label", "--workflow", "feature", "--lane", "trivial", "--because", "One string changes in one file."));
    assert.equal(code(await invoke("execute", "--run", id, "--lane", "standard", "--because", "Bigger.")), "PAVED_LANE_ESCALATION_INVALID");
    assert.equal(code(await invoke("execute", "--run", id, "--lane", "risky")), "PAVED_INTENT_RATIONALE_REQUIRED");
    assert.equal(code(await invoke("execute", "--run", id, "--workflow", "bug", "--lane", "risky", "--because", "x")), "PAVED_INTENT_FLAGS_INVALID");
  });

  it("raises a lane-free run to risky without reopening anything", async () => {
    const id = runOf(await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "A new export format is requested."));
    const escalated = await invoke("intent", "--run", id, "--lane", "risky", "--because", "Export touches customer data.");
    assert.equal(escalated.status, "success", JSON.stringify(escalated));
    const run = readRunFile(id);
    assert.equal(run.classification?.lane, "risky");
    assert.equal(statuses(run).context, "running");
  });
});

describe("flow limits", () => {
  const run = (lane?: "trivial" | "standard" | "risky") => ({ classification: lane === undefined ? {} : { lane } }) as Run;
  const policy = { protectedPaths: ["migrations/**", "src/billing/*.ts"], maxTrivialFiles: 2 };

  it("names protected files in any lane", () => {
    const violation = flowViolation(run("standard"), ["src/app.ts", "migrations/001_init.sql"], policy);
    assert.equal(violation?.reason, "protected-path");
    assert.deepEqual(violation?.files, ["migrations/001_init.sql"]);
    assert.equal(flowViolation(run(), ["src/billing/invoice.ts"], policy)?.reason, "protected-path");
    assert.equal(flowViolation(run("standard"), ["src/billing/nested/invoice.ts"], policy), undefined);
  });

  it("limits only trivial runs by file count", () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    assert.equal(flowViolation(run("trivial"), files, policy)?.reason, "trivial-too-large");
    assert.equal(flowViolation(run("trivial"), files.slice(0, 2), policy), undefined);
    assert.equal(flowViolation(run("standard"), files, policy), undefined);
    assert.equal(flowViolation(run(), files, policy), undefined);
  });
});
