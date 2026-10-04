import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import {
  applyClassificationAnswer, availableWorkflows, classificationCandidate, createIntentRun, IntentError,
  missingInputs, normalizeWorkflow, writeIntentDocument,
} from "../../cli/lib/intent.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";
import { validateRun } from "../../cli/lib/workflow-runs.ts";

const coreRoot = join(import.meta.dirname, "..", "..");
let projectRoot = "";
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), "paved-intent-")); });
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

const base = { request: "Export fails for archived items", parts: [], inputs: [] };

describe("intent classification", () => {
  it("offers the executable Core workflows", () => {
    assert.deepEqual(availableWorkflows(projectRoot, coreRoot), ["core.bug", "core.feature", "core.refactor"]);
  });

  it("hides a workflow disabled by an override that still matches its target", () => {
    mkdirSync(join(projectRoot, ".paved/overrides"), { recursive: true });
    writeFileSync(join(projectRoot, ".paved/overrides/overrides.yaml"), stringify({
      apiVersion: "paved/v1", kind: "Overrides",
      workflows: [{ target: "core.refactor", action: "disable", owner: "team", reason: "Not used here." }],
    }));
    assert.deepEqual(availableWorkflows(projectRoot, coreRoot), ["core.bug", "core.feature"]);
    assert.throws(() => normalizeWorkflow(projectRoot, coreRoot, "refactor"), (error: unknown) =>
      error instanceof IntentError && error.code === "PAVED_WORKFLOW_NOT_EXECUTABLE");
  });

  it("refuses project workflows and unknown ids", () => {
    for (const value of ["project.deploy", "release", "core.release"]) {
      assert.throws(() => normalizeWorkflow(projectRoot, coreRoot, value), (error: unknown) =>
        error instanceof IntentError && error.code === "PAVED_WORKFLOW_NOT_EXECUTABLE", value);
    }
    assert.equal(normalizeWorkflow(projectRoot, coreRoot, "bug"), "core.bug");
    assert.equal(normalizeWorkflow(projectRoot, coreRoot, "core.bug"), "core.bug");
  });

  it("classified: creates a running run whose first required input is the request", () => {
    const run = createIntentRun(projectRoot, coreRoot, { ...base, workflow: "bug", because: "Archived items crash the export." }, "abc");
    validateRun(coreRoot, run);
    assert.match(run.id, /^intent-[a-f0-9]{20}$/);
    assert.equal(run.status, "running");
    assert.deepEqual(run.workflow, { id: "core.bug", version: "0.4.0" });
    assert.deepEqual(run.classification, { workflow: "core.bug", because: "Archived items crash the export.", decided_by: "agent" });
    assert.deepEqual(run.inputs[0], { id: "report", value: base.request, source: "human" });
  });

  it("classified without a rationale is refused", () => {
    assert.throws(() => createIntentRun(projectRoot, coreRoot, { ...base, workflow: "bug" }, "abc"), (error: unknown) =>
      error instanceof IntentError && error.code === "PAVED_INTENT_RATIONALE_REQUIRED");
    assert.throws(() => createIntentRun(projectRoot, coreRoot, { ...base, recommend: "bug" }, "abc"), (error: unknown) =>
      error instanceof IntentError && error.code === "PAVED_INTENT_RATIONALE_REQUIRED");
  });

  it("records extra inputs as human inputs and rejects unknown ones", () => {
    const run = createIntentRun(projectRoot, coreRoot, { ...base, workflow: "bug", because: "x", inputs: ["environment=staging"] }, "abc");
    assert.deepEqual(run.inputs[1], { id: "environment", value: "staging", source: "human" });
    assert.throws(() => createIntentRun(projectRoot, coreRoot, { ...base, workflow: "bug", because: "x", inputs: ["colour=red"] }, "abc"),
      (error: unknown) => error instanceof IntentError && error.code === "PAVED_WORKFLOW_INPUT_INVALID");
  });

  it("reports missing required inputs", () => {
    assert.deepEqual(missingInputs(coreRoot, "core.bug", [{ id: "report", value: "x", source: "human" }]), []);
    assert.deepEqual(missingInputs(coreRoot, "core.bug", []), ["report"]);
  });

  it("uncertain: creates a pending run and a decision with every option and no own recommendation", () => {
    const run = createIntentRun(projectRoot, coreRoot, base, "abc");
    assert.equal(run.status, "awaiting-input");
    assert.deepEqual(run.phases, []);
    assert.equal(run.workflow, undefined);
    writeIntentDocument(projectRoot, run);
    const candidate = classificationCandidate(projectRoot, coreRoot, run);
    assert.deepEqual(candidate.options.map((option) => option.id), ["bug", "feature", "refactor"]);
    assert.equal(candidate.recommended, undefined);
    assert.equal(candidate.handler, "run.record");
    assert.equal(candidate.scope, "run");
    assert.equal(classificationCandidate(projectRoot, coreRoot, run, "core.bug").recommended, "bug");
  });

  it("mixed: proposes a split first and recommends it", () => {
    const run = createIntentRun(projectRoot, coreRoot, { ...base, parts: ["Add CSV export", "Fix the crash"] }, "abc");
    assert.deepEqual(run.classification, { parts: ["Add CSV export", "Fix the crash"] });
    writeIntentDocument(projectRoot, run);
    const candidate = classificationCandidate(projectRoot, coreRoot, run);
    assert.deepEqual(candidate.options.map((option) => option.id), ["split", "bug", "feature", "refactor"]);
    assert.equal(candidate.recommended, "split");
  });

  it("a single part is refused", () => {
    assert.throws(() => createIntentRun(projectRoot, coreRoot, { ...base, parts: ["Only one"] }, "abc"), (error: unknown) =>
      error instanceof IntentError && error.code === "PAVED_INTENT_PARTS_INVALID");
  });

  it("answering a workflow classifies the run; answering split cancels it", () => {
    const pending = createIntentRun(projectRoot, coreRoot, { ...base, parts: ["Add CSV export", "Fix the crash"] }, "abc");
    const answered = { id: "d-1", answer: "bug", answered_by: "maintainer", status: "APPLIED" } as unknown as Decision;
    const classified = structuredClone(pending);
    assert.deepEqual(applyClassificationAnswer(projectRoot, coreRoot, classified, answered), {});
    assert.equal(classified.status, "running");
    assert.equal(classified.inputs[0]?.id, "report");
    assert.deepEqual(classified.classification, { workflow: "core.bug", because: "Chosen by maintainer in decision d-1.", decided_by: "human", decision: "d-1", parts: ["Add CSV export", "Fix the crash"] });
    const split = structuredClone(pending);
    assert.deepEqual(applyClassificationAnswer(projectRoot, coreRoot, split, { ...answered, answer: "split" } as Decision), { split: ["Add CSV export", "Fix the crash"] });
    assert.equal(split.status, "cancelled");
    assert.ok(split.ended_at);
    assert.equal(split.events.at(-1)?.detail, "intent-split");
  });

  it("writes the Intent document with the verbatim request and the classification", () => {
    const run = createIntentRun(projectRoot, coreRoot, { ...base, workflow: "bug", because: "It crashes." }, "abc");
    const path = writeIntentDocument(projectRoot, run);
    assert.equal(path, `.paved/documents/intents/${run.id}.md`);
    const text = readFileSync(join(projectRoot, path), "utf8");
    assert.match(text, /Export fails for archived items/);
    assert.match(text, /core\.bug/);
    assert.match(text, /It crashes\./);
  });
});
