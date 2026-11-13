import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(availableWorkflows(projectRoot, coreRoot), ["core.bug", "core.feature", "core.investigation", "core.performance", "core.refactor"]);
  });

  it("hides a workflow disabled by an override that still matches its target", () => {
    mkdirSync(join(projectRoot, ".paved/overrides"), { recursive: true });
    writeFileSync(join(projectRoot, ".paved/overrides/overrides.yaml"), stringify({
      apiVersion: "paved/v1", kind: "Overrides",
      workflows: [{ target: "core.refactor", action: "disable", owner: "team", reason: "Not used here." }],
    }));
    assert.deepEqual(availableWorkflows(projectRoot, coreRoot), ["core.bug", "core.feature", "core.investigation", "core.performance"]);
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
    assert.deepEqual(run.workflow, { id: "core.bug", version: "0.4.1" });
    assert.deepEqual(run.classification, { workflow: "core.bug", because: "Archived items crash the export.", decided_by: "agent" });
    assert.deepEqual(run.inputs[0], { id: "report", value: base.request, source: "human" });
  });

  it("routes a question to investigation and a measured slowness to performance", () => {
    const question = createIntentRun(projectRoot, coreRoot, { ...base, request: "Why do archived exports time out?", workflow: "investigation",
      because: "The user asks why, and wants an answer rather than a change." }, "q1");
    validateRun(coreRoot, question);
    assert.equal(question.workflow?.id, "core.investigation");
    assert.deepEqual(question.inputs[0], { id: "question", value: "Why do archived exports time out?", source: "human" });
    const slow = createIntentRun(projectRoot, coreRoot, { ...base, request: "Exports take 12 s; make them faster", workflow: "performance",
      because: "A measured metric should improve with behavior unchanged." }, "p1");
    validateRun(coreRoot, slow);
    assert.equal(slow.workflow?.id, "core.performance");
    assert.equal(slow.inputs[0]?.id, "request");
  });

  it("an ambiguous slowness report still asks, offering both readings", () => {
    const run = createIntentRun(projectRoot, coreRoot, { ...base, request: "Exports are slow", recommend: "investigation",
      because: "It is unclear whether the user wants an explanation or a faster export." }, "amb");
    assert.equal(run.status, "awaiting-input");
    assert.equal(run.workflow, undefined);
    writeIntentDocument(projectRoot, run);
    const candidate = classificationCandidate(projectRoot, coreRoot, run, "investigation", "Unclear.");
    assert.equal(candidate.recommended, "investigation");
    assert.ok(candidate.options.some((option) => option.id === "performance"));
    assert.equal(candidate.required, true);
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
    assert.deepEqual(candidate.options.map((option) => option.id), ["bug", "feature", "investigation", "performance", "refactor"]);
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
    assert.deepEqual(candidate.options.map((option) => option.id), ["split", "bug", "feature", "investigation", "performance", "refactor"]);
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


describe("intent autonomy profiles", () => {
  const profileOf = (run: unknown) => (run as { autonomy_profile?: string }).autonomy_profile;

  it("keeps omission absent and records each explicit selection before classification", () => {
    assert.equal(profileOf(createIntentRun(projectRoot, coreRoot, base, "abc")), undefined);
    for (const autonomy of ["guided", "balanced", "autonomous"]) {
      const run = createIntentRun(projectRoot, coreRoot, { ...base, autonomy }, "abc");
      assert.equal(profileOf(run), autonomy);
      applyClassificationAnswer(projectRoot, coreRoot, run, { id: "d-0123456789abcdef0123", answer: "feature", answered_by: "owner" } as Decision);
      assert.equal(profileOf(run), autonomy);
      validateRun(coreRoot, run);
    }
  });

  it("uses the chosen workflow default only when no explicit selection exists", () => {
    const fixture = mkdtempSync(join(tmpdir(), "paved-autonomy-core-"));
    try {
      for (const name of ["schemas", "core"]) cpSync(join(coreRoot, name), join(fixture, name), { recursive: true });
      const path = join(fixture, "core/workflows/feature/workflow.yaml");
      writeFileSync(path, readFileSync(path, "utf8") + "\nautonomy:\n  default_profile: guided\n");
      for (const autonomy of [undefined, "balanced", "autonomous"]) {
        const input = { ...base, ...(autonomy === undefined ? {} : { autonomy }) };
        const classified = createIntentRun(projectRoot, fixture, { ...input, workflow: "feature", because: "New." }, "abc");
        assert.equal(profileOf(classified), autonomy ?? "guided");
        const pending = createIntentRun(projectRoot, fixture, input, "abc");
        applyClassificationAnswer(projectRoot, fixture, pending, { id: "d-0123456789abcdef0123", answer: "feature", answered_by: "owner" } as Decision);
        assert.equal(profileOf(pending), autonomy ?? "guided");
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("refuses unknown profiles even before a workflow is chosen", () => {
    assert.throws(() => createIntentRun(projectRoot, coreRoot, { ...base, autonomy: "unchecked" }, "abc"),
      (error: unknown) => error instanceof IntentError && error.code === "PAVED_AUTONOMY_PROFILE_INVALID");
  });
});
