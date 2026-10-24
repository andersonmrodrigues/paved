import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeHarnessEvaluation } from "../../cli/analyze-harness-evaluation.mjs";

const row = (repetition: number, checks: Record<string, boolean>, duration: number, tokens: number) => ({ repetition, model: "codex-model", effort: "high", checks, review: "accepted", reviewer: "reviewer-1", evidence: `.paved/verification/evidence/run-${repetition}.yaml`, input_tokens: tokens, output_tokens: 10, duration_ms: duration });
const dataset = () => ({
  apiVersion: "paved/v1", kind: "HarnessEvaluation", id: "task-probe", repository_revision: "a".repeat(40), host: "codex", host_version: "1.0",
  acceptance_criteria: ["behavior", "regression"],
  variants: [
    { task_id: "base", role: "baseline", changes: [], measurements: [row(1, { behavior: true, regression: true }, 100, 100), row(2, { behavior: true, regression: true }, 110, 100), row(3, { behavior: true, regression: true }, 90, 100)] },
    { task_id: "candidate", role: "candidate", changes: [{ id: "brief", target: "prompt", rationale: "State output boundary" }], measurements: [row(1, { behavior: true, regression: true }, 80, 80), row(2, { behavior: true, regression: true }, 90, 80), row(3, { behavior: true, regression: true }, 70, 80)] },
  ],
});

describe("task-level harness evaluation", () => {
  it("recommends an isolated candidate only when quality is preserved and comparable metrics improve", () => {
    const result = analyzeHarnessEvaluation(dataset());
    assert.equal(result.recommendation, "candidate");
    assert.equal(result.candidates[0]?.eligible, true);
    assert.equal(result.candidates[0]?.metric_delta_percent.duration_ms, -20);
  });

  it("keeps the baseline when a candidate regresses an acceptance criterion", () => {
    const input = dataset();
    input.variants[1]!.measurements[0]!.checks.regression = false;
    const result = analyzeHarnessEvaluation(input);
    assert.equal(result.recommendation, "base");
    assert.equal(result.candidates[0]?.eligible, false);
  });

  it("keeps the baseline when multiple candidates qualify without a declared metric weighting", () => {
    const input = dataset();
    input.variants.push({ ...input.variants[1]!, task_id: "candidate-two" });
    const result = analyzeHarnessEvaluation(input);
    assert.equal(result.recommendation, "base");
    assert.match(result.rationale, /multiple candidates qualify/);
  });

  it("rejects unpaired runs and missing independent review", () => {
    const unpaired = dataset();
    unpaired.variants[1]!.measurements[2]!.repetition = 4;
    assert.throws(() => analyzeHarnessEvaluation(unpaired), /same paired repetition ids/);
    const unreviewed = dataset();
    unreviewed.variants[1]!.measurements[0]!.review = "unavailable";
    assert.throws(() => analyzeHarnessEvaluation(unreviewed), /no accepted independent review/);
    const mismatchedModel = dataset();
    mismatchedModel.variants[1]!.measurements[0]!.model = "other-model";
    assert.throws(() => analyzeHarnessEvaluation(mismatchedModel), /baseline model and effort/);
  });
});
