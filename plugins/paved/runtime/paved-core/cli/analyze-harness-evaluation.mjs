#!/usr/bin/env node
import { resolve } from "node:path";
import { createRegistry } from "./lib/schemas.ts";
import { loadYaml } from "./lib/documents.ts";

const SCHEMA = "urn:paved:schema:harness-evaluation:v1";
const ROOT = resolve(import.meta.dirname, "..");
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function analyzeHarnessEvaluation(dataset) {
  const validation = createRegistry(resolve(ROOT, "schemas"), ["paved/v1"]).validateAs(SCHEMA, dataset);
  if (!validation.valid) throw new Error(`Harness evaluation is invalid: ${validation.errors.join("; ")}`);
  const baselines = dataset.variants.filter((variant) => variant.role === "baseline");
  const candidates = dataset.variants.filter((variant) => variant.role === "candidate");
  if (baselines.length !== 1 || candidates.length < 1) throw new Error("Evaluation requires exactly one baseline and at least one candidate.");
  const baseline = baselines[0];
  if (baseline.changes.length) throw new Error("Baseline cannot declare harness changes.");
  const criteria = [...dataset.acceptance_criteria].sort();
  const index = (variant) => {
    const rows = new Map();
    for (const row of variant.measurements) {
      if (rows.has(row.repetition)) throw new Error(`Variant ${variant.task_id} repeats measurement ${row.repetition}.`);
      const keys = Object.keys(row.checks).sort();
      if (JSON.stringify(keys) !== JSON.stringify(criteria)) throw new Error(`Variant ${variant.task_id} measurement ${row.repetition} must report exactly the shared acceptance criteria.`);
      if (row.review !== "accepted") throw new Error(`Variant ${variant.task_id} measurement ${row.repetition} has no accepted independent review.`);
      if (variant.role !== "baseline") {
        const baselineRow = baselineRows.get(row.repetition);
        if (baselineRow && (row.model !== baselineRow.model || row.effort !== baselineRow.effort)) throw new Error(`Variant ${variant.task_id} measurement ${row.repetition} must use the baseline model and effort to isolate harness changes.`);
      }
      rows.set(row.repetition, row);
    }
    return rows;
  };
  const baselineRows = index(baseline);
  const summarize = (variant) => {
    const rows = index(variant);
    if (JSON.stringify([...rows.keys()].sort((a, b) => a - b)) !== JSON.stringify([...baselineRows.keys()].sort((a, b) => a - b))) throw new Error(`Variant ${variant.task_id} must have the same paired repetition ids as the baseline.`);
    const quality = Object.fromEntries(criteria.map((criterion) => [criterion, rows.size ? [...rows.values()].filter((row) => row.checks[criterion]).length / rows.size : 0]));
    const metrics = Object.fromEntries(["input_tokens", "output_tokens", "duration_ms", "cost_usd"].map((key) => {
      const values = [...rows.values()].map((row) => row[key]);
      return [key, values.some((value) => value === undefined) ? null : median(values)];
    }));
    return { task_id: variant.task_id, quality, metrics };
  };
  const base = summarize(baseline);
  const results = candidates.map((variant) => {
    const candidateRows = index(variant);
    const candidate = summarize(variant);
    const qualityNonRegressing = criteria.every((criterion) => candidate.quality[criterion] >= base.quality[criterion]);
    const compared = ["input_tokens", "output_tokens", "duration_ms", "cost_usd"].filter((key) => base.metrics[key] !== null && candidate.metrics[key] !== null);
    const metricDeltas = Object.fromEntries(compared.map((key) => {
      const paired = [...candidateRows.entries()].map(([repetition, row]) => {
        const before = baselineRows.get(repetition)[key];
        const after = row[key];
        return before === 0 ? (after === 0 ? 0 : null) : ((after - before) / before) * 100;
      });
      return [key, paired.some((value) => value === undefined || value === null) ? null : median(paired)];
    }));
    const noMetricRegression = compared.length > 0 && compared.every((key) => metricDeltas[key] !== null && metricDeltas[key] <= 0);
    const measuredGain = compared.some((key) => metricDeltas[key] !== null && metricDeltas[key] < 0);
    return { ...candidate, metric_delta_percent: metricDeltas, eligible: qualityNonRegressing && noMetricRegression && measuredGain };
  });
  const eligible = results.filter((result) => result.eligible);
  const selected = eligible.length === 1 ? eligible[0] : undefined;
  const rationale = selected
    ? "Candidate preserves every measured acceptance criterion and improves at least one comparable host-reported metric without regressing another."
    : eligible.length > 1
      ? "Keep the baseline pending human choice: multiple candidates qualify and no metric weighting policy is defined."
      : "Keep the baseline: no candidate showed a measured efficiency gain without quality or metric regression.";
  return { evaluation_id: dataset.id, repository_revision: dataset.repository_revision, host: dataset.host, host_version: dataset.host_version, baseline: base, candidates: results, recommendation: selected ? selected.task_id : baseline.task_id, rationale };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    if (!process.argv[2]) throw new Error("Usage: npm run benchmark:harness -- <evaluation.yaml>");
    process.stdout.write(`${JSON.stringify(analyzeHarnessEvaluation(loadYaml(resolve(process.cwd(), process.argv[2]))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
