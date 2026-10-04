import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import { companionDocuments, reviewBlock, reviewFor, writeReviewDocument } from "../../cli/lib/review-block.ts";
import type { Run } from "../../cli/lib/workflow-runs.ts";

let projectRoot = "";
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), "paved-review-")); });
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

const id = "intent-0123456789abcdef0123";
const base: Run = {
  apiVersion: "paved/v1", kind: "WorkflowRun", id, revision: "abc", started_at: "2026-10-04T10:00:00Z",
  status: "awaiting-input", classification: {}, inputs: [{ id: "request", value: "x", source: "human" }], phases: [], events: [],
};

describe("review block", () => {
  it("names the target and the preview command", () => {
    assert.deepEqual(reviewBlock(".paved/documents/plans/x.md"), {
      target: ".paved/documents/plans/x.md", preview: "paved preview start .paved/documents/plans/x.md --json", companions: [],
    });
  });

  it("points a pending classification to the Intent document", () => {
    assert.equal(reviewFor(projectRoot, base)?.target, `.paved/documents/intents/${id}.md`);
  });

  it("points a plan awaiting approval to the plan file and lists the run's other documents", () => {
    mkdirSync(join(projectRoot, ".paved/documents/intents"), { recursive: true });
    mkdirSync(join(projectRoot, ".paved/documents/specs"), { recursive: true });
    mkdirSync(join(projectRoot, ".paved/documents/plans"), { recursive: true });
    writeFileSync(join(projectRoot, `.paved/documents/intents/${id}.md`), "# Intent\n");
    writeFileSync(join(projectRoot, `.paved/documents/specs/${id}-export.md`), "# Spec\n");
    writeFileSync(join(projectRoot, `.paved/documents/plans/${id}.md`), "# Plan\n");
    writeFileSync(join(projectRoot, ".paved/documents/specs/other-run.md"), "# Unrelated\n");
    const run: Run = {
      ...base, status: "awaiting-approval", workflow: { id: "core.feature", version: "0.4.0" },
      phases: [{ phase: "planning", status: "running", gates: [{ id: "plan-approved", status: "awaiting-approval" }] }],
      events: [{ at: "2026-10-04T10:00:00Z", type: "approval-requested", phase: "planning", ref: `.paved/documents/plans/${id}.md` }],
    };
    const block = reviewFor(projectRoot, run);
    assert.equal(block?.target, `.paved/documents/plans/${id}.md`);
    assert.deepEqual(block?.companions, [`.paved/documents/intents/${id}.md`, `.paved/documents/specs/${id}-export.md`]);
    assert.deepEqual(companionDocuments(projectRoot, id, `.paved/documents/plans/${id}.md`), block?.companions);
  });

  it("renders the review document from the evidence record during review", () => {
    mkdirSync(join(projectRoot, ".paved/generated/evidence"), { recursive: true });
    writeFileSync(join(projectRoot, ".paved/generated/evidence/run.yaml"), stringify({
      change: { summary: "Enabled the export." },
      checks: [{ id: "c1", check: "project.unit", type: "unit", status: "passed", summary: "12 tests" }],
      artifacts: [{ id: "diff", kind: "diff", description: "Change diff.", source: { type: "file", location: ".paved/generated/evidence/diff.md" } }],
      gaps: [{ check_type: "e2e", description: "Browser checks were not run.", reason: "No browser available.", risk: "medium" }],
      rules: [{ id: "core.rule", severity: "error", status: "satisfied" }],
    }));
    const run: Run = {
      ...base, status: "running", workflow: { id: "core.feature", version: "0.4.0" }, evidence: ".paved/generated/evidence/run.yaml",
      phases: [{ phase: "review", status: "running" }],
      events: [{ at: "2026-10-04T10:00:00Z", type: "approval-requested", phase: "planning", ref: `.paved/documents/plans/${id}.md` }],
    };
    const path = writeReviewDocument(projectRoot, run);
    assert.equal(path, `.paved/generated/reviews/${id}.md`);
    const text = readFileSync(join(projectRoot, path), "utf8");
    for (const expected of ["Enabled the export.", "project.unit", "passed", "diff.md", "No browser available.", "core.rule", "satisfied", `plans/${id}.md`]) {
      assert.ok(text.includes(expected), `missing ${expected}`);
    }
    assert.equal(reviewFor(projectRoot, run)?.target, path);
  });
});
