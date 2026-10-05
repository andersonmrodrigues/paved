import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { loadContract, writeRun, type Run } from "../../cli/lib/workflow-runs.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let project = "";
const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", project, "--json"], cwd: project, executablePath: join(core, "cli", "index.ts") });
const runOf = (result: { data?: unknown }) => (result.data as { run: string }).run;
const readRunFile = (id: string) => parse(readFileSync(join(project, ".paved/generated/runs", `${id}.yaml`), "utf8")) as Run;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "paved-steps-"));
  writeFileSync(join(project, "README.md"), "# Consumer\n");
  initializeConsumer(core, project, "consumer");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("intent, plan and execute", () => {
  it("intent classifies and starts the run in context", async () => {
    const started = await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "A new export format is requested.");
    assert.equal(started.status, "success", JSON.stringify(started));
    const run = readRunFile(runOf(started));
    assert.equal(run.workflow?.id, "core.feature");
    assert.equal(run.phases[0]?.status, "running");
    assert.match(readFileSync(join(project, `.paved/documents/intents/${run.id}.md`), "utf8"), /Add CSV export/);
  });

  it("intent without --because is refused", async () => {
    const result = await invoke("intent", "Add CSV export", "--workflow", "feature");
    assert.equal(result.diagnostics[0]?.code, "PAVED_INTENT_RATIONALE_REQUIRED");
  });

  it("intent refuses a project workflow", async () => {
    const result = await invoke("intent", "Deploy", "--workflow", "project.deploy", "--because", "x");
    assert.equal(result.diagnostics[0]?.code, "PAVED_WORKFLOW_NOT_EXECUTABLE");
  });

  it("uncertain intent waits for a classification decision, then classifies on the answer", async () => {
    const pending = await invoke("intent", "Make exports work for archived items", "--recommend", "bug", "--because", "The report says it fails.");
    assert.equal(pending.status, "awaiting_input", JSON.stringify(pending));
    const decision = pending.decisions?.[0];
    assert.deepEqual(decision?.options.map((option) => option.id), ["bug", "feature", "refactor"]);
    assert.equal(decision?.recommended, "bug");
    const id = runOf(pending);
    assert.equal(readRunFile(id).phases.length, 0);
    const classified = await invoke("intent", "--run", id, "--answer", `${decision!.id}=bug`, "--answered-by", "maintainer@example.com");
    assert.equal(classified.status, "success", JSON.stringify(classified));
    const run = readRunFile(id);
    assert.equal(run.workflow?.id, "core.bug");
    assert.equal(run.classification?.decided_by, "human");
    assert.equal(run.inputs[0]?.id, "report");
  });

  it("a pending classification and a plan awaiting approval carry the review block", async () => {
    const pending = await invoke("intent", "Make exports work", "--recommend", "bug", "--because", "Report.");
    assert.equal((pending.data as { review?: { target: string } }).review?.target, `.paved/documents/intents/${runOf(pending)}.md`);
    const id = runOf(await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "New behavior."));
    await invoke("intent", "--run", id, "--advance", "--note", "Scope is clear");
    await invoke("intent", "--run", id, "--advance", "--note", "Architecture inspected");
    mkdirSync(join(project, ".paved/documents/plans"), { recursive: true });
    writeFileSync(join(project, `.paved/documents/plans/${id}.md`), "# Plan\n");
    const requested = await invoke("plan", "--run", id, "--advance", "--note", "Plan", "--evidence", `.paved/documents/plans/${id}.md`);
    const review = (requested.data as { review?: { target: string; companions: string[] } }).review;
    assert.equal(review?.target, `.paved/documents/plans/${id}.md`);
    assert.deepEqual(review?.companions, [`.paved/documents/intents/${id}.md`]);
  });

  it("a pending classification refuses answers that are not its own", async () => {
    const pending = await invoke("intent", "Make exports work", "--recommend", "bug", "--because", "Report.");
    const stray = await invoke("intent", "--run", runOf(pending), "--answer", "d-0123456789abcdef0123=bug", "--answered-by", "maintainer@example.com");
    assert.equal(stray.diagnostics[0]?.code, "PAVED_DECISION_ANSWER_INVALID", JSON.stringify(stray));
    assert.equal(readRunFile(runOf(pending)).workflow, undefined);
  });

  it("a mixed intent split cancels the run and lists one intent per part", async () => {
    const pending = await invoke("intent", "Add CSV export and fix the crash", "--part", "Add CSV export", "--part", "Fix the archived-items crash");
    const decision = pending.decisions?.[0];
    assert.equal(decision?.recommended, "split");
    const split = await invoke("intent", "--run", runOf(pending), "--answer", `${decision!.id}=split`, "--answered-by", "maintainer@example.com");
    assert.equal(readRunFile(runOf(pending)).status, "cancelled");
    const next = (split.data as { nextAction: string }).nextAction;
    assert.match(next, /paved intent "Add CSV export"/);
    assert.match(next, /paved intent "Fix the archived-items crash"/);
  });

  it("the same request after a finished run starts a new run", async () => {
    const pending = await invoke("intent", "Add CSV export and fix the crash", "--part", "Add CSV export", "--part", "Fix the crash");
    await invoke("intent", "--run", runOf(pending), "--answer", `${pending.decisions![0]!.id}=split`, "--answered-by", "maintainer@example.com");
    const again = await invoke("intent", "Add CSV export and fix the crash", "--workflow", "feature", "--because", "The user chose one run.");
    assert.equal(again.status, "success", JSON.stringify(again));
    assert.notEqual(runOf(again), runOf(pending));
    assert.equal(readRunFile(runOf(again)).workflow?.id, "core.feature");
    assert.equal(readRunFile(runOf(pending)).status, "cancelled");
  });

  it("a classification that contradicts the open run for the same request is refused", async () => {
    const pending = await invoke("intent", "Speed up export");
    const id = runOf(pending);
    const conflicting = await invoke("intent", "Speed up export", "--workflow", "refactor", "--because", "Behavior stays the same.");
    assert.equal(conflicting.diagnostics[0]?.code, "PAVED_INTENT_RUN_EXISTS", JSON.stringify(conflicting));
    assert.match(conflicting.diagnostics[0]?.remediation ?? "", new RegExp(`paved intent --run ${id} --answer`));
    assert.equal(readRunFile(id).workflow, undefined);
    const repeated = await invoke("intent", "Speed up export");
    assert.equal(runOf(repeated), id);
  });

  it("intent refuses flags it would otherwise ignore", async () => {
    const cases: [string[], string][] = [
      [["intent", "Add CSV export", "--because", "New format."], "PAVED_INTENT_FLAGS_INVALID"],
      [["intent", "Add CSV export", "--input", "acceptance-criteria=CSV downloads"], "PAVED_INTENT_FLAGS_INVALID"],
      [["intent", "Export fails", "--workflow", "bug", "--because", "It fails.", "--input", "report=Other text"], "PAVED_WORKFLOW_INPUT_INVALID"],
      [["intent", "Add CSV export", "--workflow", "feature", "--because", "New.", "--input", "request=Other text"], "PAVED_WORKFLOW_INPUT_INVALID"],
    ];
    for (const [argv, code] of cases) {
      const result = await invoke(...argv);
      assert.equal(result.diagnostics[0]?.code, code, `${argv.join(" ")}: ${JSON.stringify(result.diagnostics)}`);
    }
    const pending = await invoke("intent", "Speed up export");
    for (const flags of [["--workflow", "refactor", "--because", "x"], ["--recommend", "refactor", "--because", "x"], ["--part", "a", "--part", "b"], ["--because", "x"]]) {
      const result = await invoke("intent", "--run", runOf(pending), ...flags);
      assert.equal(result.diagnostics[0]?.code, "PAVED_INTENT_FLAGS_INVALID", `${flags.join(" ")}: ${JSON.stringify(result.diagnostics)}`);
      assert.match(result.diagnostics[0]?.remediation ?? "", /--answer/);
    }
    assert.equal(readRunFile(runOf(pending)).workflow, undefined);
  });

  it("bug discovery reports why the testing Tool could not run", async () => {
    const id = runOf(await invoke("intent", "Export fails for archived items", "--workflow", "bug", "--because", "A failure is reported."));
    assert.equal((await invoke("intent", "--run", id, "--advance", "--note", "Expected behavior is clear")).status, "success");
    const discovery = await invoke("intent", "--run", id, "--advance", "--note", "Suspected cause");
    const code = discovery.diagnostics[0]?.code ?? "";
    assert.match(code, /^PAVED_TEST_/, JSON.stringify(discovery.diagnostics));
    assert.doesNotMatch(discovery.diagnostics[0]?.remediation ?? "", /Write a regression test/);
  });

  it("an unreadable run is named instead of breaking status and run selection", async () => {
    const id = runOf(await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "New format."));
    writeFileSync(join(project, ".paved/generated/runs", "intent-broken.yaml"), "id: [unclosed\n");

    const status = await invoke("status");
    assert.deepEqual((status.data as { openRuns: { run: string }[] }).openRuns.map((run) => run.run), [id]);
    const warning = status.diagnostics.find((diagnostic) => diagnostic.code === "PAVED_WORKFLOW_RUN_INVALID");
    assert.match(warning?.message ?? "", /intent-broken/);

    const selected = await invoke("plan", "--advance");
    assert.equal(selected.diagnostics[0]?.code, "PAVED_WORKFLOW_RUN_INVALID", JSON.stringify(selected.diagnostics));
    assert.match(selected.diagnostics[0]?.message ?? "", /intent-broken/);
    assert.match(selected.diagnostics[0]?.remediation ?? "", /--run/);
    assert.equal((await invoke("intent", "--run", id)).status, "success");
  });

  it("each step refuses phases it does not own and names the owner", async () => {
    const id = runOf(await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "New behavior."));
    const plan = await invoke("plan", "--run", id, "--advance", "--note", "x");
    assert.equal(plan.diagnostics[0]?.code, "PAVED_WORKFLOW_STEP_OUT_OF_RANGE");
    assert.match(plan.diagnostics[0]?.remediation ?? "", /paved intent --run/);
  });

  it("execute refuses a run whose plan is not approved", async () => {
    const id = runOf(await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "New behavior."));
    assert.equal((await invoke("execute", "--run", id, "--advance", "--note", "x")).diagnostics[0]?.code, "PAVED_WORKFLOW_PLAN_UNAPPROVED");
  });

  it("plan and execute act on the only open run, and ask when several are open", async () => {
    assert.equal((await invoke("plan", "--advance")).diagnostics[0]?.code, "PAVED_WORKFLOW_RUN_REQUIRED");
    const first = runOf(await invoke("intent", "Add CSV export", "--workflow", "feature", "--because", "New behavior."));
    assert.equal((await invoke("plan")).diagnostics[0]?.code, "PAVED_WORKFLOW_STEP_OUT_OF_RANGE");
    const second = runOf(await invoke("intent", "Add JSON export", "--workflow", "feature", "--because", "New behavior."));
    const asked = await invoke("plan", "--advance");
    assert.equal(asked.status, "awaiting_input", JSON.stringify(asked));
    const decision = asked.decisions?.[0];
    assert.deepEqual(decision?.options.map((option) => option.id).sort(), [first, second].sort());
    assert.equal(decision?.recommended, undefined);
    const chosen = await invoke("intent", "--advance", "--note", "Scope is clear", "--answer", `${decision!.id}=${first}`, "--answered-by", "maintainer@example.com");
    assert.equal(chosen.status, "success", JSON.stringify(chosen));
    assert.equal(runOf(chosen), first);
    assert.equal(readRunFile(first).phases[1]?.status, "running");
    assert.equal(readRunFile(second).phases[0]?.status, "running");
  });

  it("resumes a 1.x run with the step that owns its current phase and keeps its decision ids", async () => {
    const contract = loadContract(core, "core.feature");
    const legacy: Run = {
      apiVersion: "paved/v1", kind: "WorkflowRun", id: "feature-0123456789abcdef0123",
      workflow: { id: contract.id, version: contract.version }, revision: "unversioned", started_at: new Date().toISOString(),
      status: "running", inputs: [{ id: "request", value: "Legacy request", source: "human" }],
      phases: contract.phases.map((phase, index) => ({ phase: phase.phase, status: index === 0 ? "running" : "pending", ...(index === 0 ? { attempts: 1 } : {}) })),
      events: [{ at: new Date().toISOString(), type: "run-started", detail: "source_sha256=0" }],
    };
    writeRun(project, core, legacy);
    const readme = "# Consumer\n";
    const raised = await invoke("decision", "raise", "--decision", JSON.stringify({
      run: legacy.id, question: "Which behavior?", reason: "Unstated.",
      options: [
        { id: "first", label: "First", description: "First.", consequence: "First." },
        { id: "second", label: "Second", description: "Second.", consequence: "Second." },
      ],
      evidence: [{ type: "file", location: "README.md", sha256: createHash("sha256").update(readme).digest("hex") }],
      required: true, requiredAnswer: { type: "single-choice" }, effect: "record-only", candidates: ["first", "second"],
    }));
    const id = (raised.data as { id: string }).id;
    const resumed = await invoke("intent", "--run", legacy.id, "--advance", "--note", "Scope is clear", "--answer", `${id}=first`, "--answered-by", "maintainer@example.com");
    assert.equal(resumed.status, "success", JSON.stringify(resumed));
    const run = readRunFile(legacy.id);
    assert.equal(run.decisions?.[0]?.id, id);
    assert.equal(run.decisions?.[0]?.command, "feature");
    assert.equal(run.phases[1]?.status, "running");
  });

  it("relays testing-Tool decisions and keeps run answers apart", async () => {
    mkdirSync(join(project, ".paved/tools"), { recursive: true });
    mkdirSync(join(project, ".paved/tool-implementations"), { recursive: true });
    writeFileSync(join(project, ".paved/tools/runner.mjs"), 'process.stdout.write(JSON.stringify({status: "passed", output: ""}));\n');
    const tool = parse(readFileSync(join(core, "core/tools/testing/run.yaml"), "utf8")) as Record<string, unknown>;
    for (const name of ["alpha", "beta"]) {
      writeFileSync(join(project, `.paved/tools/${name}.yaml`), stringify({ ...tool, id: `project.testing.${name}` }));
      writeFileSync(join(project, `.paved/tool-implementations/${name}.yaml`), stringify({
        apiVersion: "paved/v1", kind: "ToolImplementation", id: `project.testing.${name}`, tool: `project.testing.${name}`,
        version: "1.0.0", contract: "^0.1.0", source: "project", environments: ["local"],
        invocation: { type: "command", executable: "node", arguments: ["--", ".paved/tools/runner.mjs"] },
        availability: "available",
      }));
    }
    const id = runOf(await invoke("intent", "Simplify the README", "--workflow", "refactor", "--because", "Structure only."));
    await invoke("intent", "--run", id, "--advance", "--note", "Behavior must stay the same");
    writeFileSync(join(project, "baseline.md"), "baseline\n");
    const relayed = await invoke("intent", "--run", id, "--advance", "--note", "Baseline", "--evidence", "baseline.md");
    assert.equal(relayed.status, "awaiting_input", JSON.stringify(relayed));
    const toolDecision = relayed.decisions?.[0];
    assert.match(toolDecision?.question ?? "", /testing Tool/);
    assert.equal(readRunFile(id).phases[1]?.status, "running");
    const answered = await invoke("intent", "--run", id, "--advance", "--note", "Baseline", "--evidence", "baseline.md",
      "--answer", `${toolDecision!.id}=${toolDecision!.options[0]!.id}`, "--answered-by", "maintainer@example.com");
    assert.notEqual(answered.diagnostics[0]?.code, "PAVED_DECISION_ANSWER_INVALID", JSON.stringify(answered));
    assert.ok(!(answered.decisions ?? []).some((item) => item.id === toolDecision!.id));
    const stray = await invoke("plan", "--run", id, "--answer", `${toolDecision!.id}=x`, "--answered-by", "maintainer@example.com");
    assert.equal(stray.diagnostics[0]?.code, "PAVED_DECISION_ANSWER_INVALID", JSON.stringify(stray));
  });
});
