import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { at } from "../helpers.ts";
import { analyzeEvaluation } from "../../cli/analyze-delegation-evaluation.mjs";

const fixture = () => loadYaml(at("tests", "fixtures", "schemas", "delegation-evaluation", "valid", "paired-three-runs.yaml")) as any;

describe("delegation evaluation analyzer", () => {
  it("summarizes paired quality, latency, tokens, cost and retries reproducibly", () => {
    const result = analyzeEvaluation(fixture());
    assert.equal(result.repetitions, 3);
    assert.equal(result.quality.sequential.acceptance_pass_ratio, 11 / 12);
    assert.equal(result.quality.delegated.acceptance_pass_ratio, 1);
    assert.equal(result.duration_ms.sequential_median, 12500);
    assert.equal(result.duration_ms.delegated_median, 8500);
    assert.ok(result.duration_ms.paired_median_delta_percent !== null && result.duration_ms.paired_median_delta_percent < 0);
    assert.ok(result.tokens_input_output.paired_median_delta_percent !== null && result.tokens_input_output.paired_median_delta_percent < 0);
    assert.ok(result.cost_usd.paired_median_delta_percent !== null && result.cost_usd.paired_median_delta_percent < 0);
    assert.equal(result.retries.delegated_median, 0);
  });

  it("rejects unpaired, duplicated and fewer than three repetitions", () => {
    const unpaired = fixture();
    unpaired.measurements = unpaired.measurements.map((row: any) => row.strategy === "delegated" && row.repetition === 2 ? { ...row, repetition: 4 } : row);
    assert.throws(() => analyzeEvaluation(unpaired), /same repetition ids/);
    const duplicate = fixture();
    duplicate.measurements.push({ ...duplicate.measurements[0] });
    assert.throws(() => analyzeEvaluation(duplicate), /Duplicate sequential measurement/);
    const tooFew = fixture();
    tooFew.measurements = tooFew.measurements.slice(0, 4);
    assert.throws(() => analyzeEvaluation(tooFew), /Evaluation dataset is invalid/);
  });

  it("rejects impossible acceptance-check counts", () => {
    const dataset = fixture();
    dataset.measurements[0].acceptance_passed = dataset.measurements[0].acceptance_total + 1;
    assert.throws(() => analyzeEvaluation(dataset), /more passed acceptance checks/);
    const noChecks = fixture();
    noChecks.measurements[0].acceptance_total = 0;
    assert.throws(() => analyzeEvaluation(noChecks), /Evaluation dataset is invalid|at least one acceptance check/);
  });

  it("leaves unavailable cost and reasoning measurements unestimated", () => {
    const dataset = fixture();
    for (const row of dataset.measurements) {
      delete row.cost_usd;
      delete row.reasoning_tokens;
    }
    const result = analyzeEvaluation(dataset);
    assert.equal(result.cost_usd.missing, true);
    assert.equal(result.cost_usd.paired_median_delta_percent, null);
    assert.equal(result.reasoning_tokens.missing, true);
  });
});
