import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import type { PhaseContext } from "../../cli/lib/workflow-gates/index.ts";
import { review, reviewedState, reviewRecordPath, type ReviewFinding } from "../../cli/lib/workflow-gates/review.ts";
import type { Run } from "../../cli/lib/workflow-runs.ts";
import { REVIEW_HANDLER } from "../../cli/lib/workflows.ts";

const coreRoot = join(import.meta.dirname, "../..");
const id = "intent-0123456789abcdef0123";
const executed = { level: "executed", command: "node --test tests/flag.test.ts", output_sha256: "b".repeat(64) } as const;

let projectRoot = "";
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "paved-review-gate-"));
  mkdirSync(join(projectRoot, ".paved/documents/plans"), { recursive: true });
  mkdirSync(join(projectRoot, ".paved/generated/evidence"), { recursive: true });
  writeFileSync(join(projectRoot, `.paved/documents/plans/${id}.md`), "# Plan\n");
  writeFileSync(join(projectRoot, `.paved/generated/evidence/${id}.yaml`), "change: { summary: Enabled the flag. }\n");
});
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

function inReview(): Run {
  return {
    apiVersion: "paved/v1", kind: "WorkflowRun", id, revision: "abc", started_at: "2026-11-13T10:00:00Z", status: "running",
    workflow: { id: "core.feature", version: "0.5.0" }, evidence: `.paved/generated/evidence/${id}.yaml`, inputs: [],
    phases: [{ phase: "review", status: "running" }],
    events: [{ at: "2026-11-13T10:00:00Z", type: "approval-requested", phase: "planning", ref: `.paved/documents/plans/${id}.md` }],
  };
}

/** Writes the record an isolated reviewer would for the run's current state and returns its digest. */
function record(run: Run, findings: ReviewFinding[]): { path: string; digest: string } {
  const path = join(projectRoot, reviewRecordPath(id));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, stringify({
    apiVersion: "paved/v1", kind: "ChangeReview", run: id, reviewer: { agent: "test reviewer", isolated: true },
    reviewed: reviewedState(projectRoot, run), passes: ["rules", "diff", "change"], findings,
  }));
  return { path, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

const gate = (run: Run, evidence: string) => review({ run, projectRoot, coreRoot, evidence } as unknown as PhaseContext);

describe("review gate proof", () => {
  it("refuses a blocking finding with no proof or with proof short of execution", async () => {
    const run = inReview();
    const { path } = record(run, [
      { severity: "blocking", file: "feature.js", line: 1, summary: "The flag is a string." },
      { severity: "blocking", file: "feature.js", line: 2, summary: "The default is wrong.", proof: { level: "reasoned" } },
      { severity: "blocking", file: "feature.js", line: 3, summary: "Throws on empty input.", proof: executed },
    ]);

    const outcome = await gate(run, path);

    assert.equal(outcome.kind, "blocked");
    assert.ok(outcome.kind === "blocked");
    assert.equal(outcome.code, "PAVED_REVIEW_FINDING_UNPROVEN");
    assert.match(outcome.message, /feature\.js:1 \(no proof\), feature\.js:2 \(reasoned\)\.$/);
    assert.match(outcome.remediation, /severity note/);
    assert.equal(run.events.length, 1, "a refused review records nothing");
  });

  it("asks the user about executed or reproduced blocking findings and names their proof", async () => {
    const run = inReview();
    const { path } = record(run, [
      { severity: "blocking", file: "feature.js", line: 3, summary: "Throws on empty input.", proof: executed },
      { severity: "blocking", file: "app.js", summary: "The page shows the raw flag.", proof: { ...executed, level: "reproduced", command: "curl -s localhost:3000/" } },
    ]);

    const outcome = await gate(run, path);

    assert.equal(outcome.kind, "ask");
    assert.ok(outcome.kind === "ask");
    assert.match(outcome.candidate.reason, /feature\.js:3 \[executed\]: Throws on empty input\. app\.js \[reproduced\]/);
  });

  it("passes notes at any proof level", async () => {
    const run = inReview();
    const { path } = record(run, [
      { severity: "note", file: "feature.js", summary: "May be slow.", proof: { level: "asserted" } },
      { severity: "note", file: "feature.js", summary: "Unproven race.", proof: { level: "reasoned", expected: "Serialized writes." } },
      { severity: "note", file: "feature.js", summary: "No proof at all." },
    ]);

    const outcome = await gate(run, path);

    assert.equal(outcome.kind, "pass");
    assert.match(run.events.at(-1)!.detail!, /blocking=0; notes=3/);
  });

  it("keeps a decision the user already made on an unproven record", async () => {
    const run = inReview();
    const { path, digest } = record(run, [{ severity: "blocking", file: "feature.js", line: 1, summary: "The flag is a string." }]);
    run.decisions = [{ handler: REVIEW_HANDLER, status: "APPLIED", answer: "accept", evidence: [{ type: "file", location: reviewRecordPath(id), sha256: digest }] }] as unknown as NonNullable<Run["decisions"]>;

    const outcome = await gate(run, path);

    assert.equal(outcome.kind, "pass");
    assert.match(run.events.at(-1)!.detail!, /blocking=1 \(accepted\)/);
  });
});
