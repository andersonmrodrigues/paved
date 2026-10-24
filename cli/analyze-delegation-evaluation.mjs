#!/usr/bin/env node
import { resolve } from "node:path";
import { createRegistry } from "./lib/schemas.ts";
import { loadYaml } from "./lib/documents.ts";

const SCHEMA = "urn:paved:schema:delegation-evaluation:v1";
const ROOT = resolve(import.meta.dirname, "..");

export function analyzeEvaluation(dataset) {
  const validation = createRegistry(resolve(ROOT, "schemas"), ["paved/v1"]).validateAs(SCHEMA, dataset);
  if (!validation.valid) throw new Error(`Evaluation dataset is invalid: ${validation.errors.join("; ")}`);

  const groups = { sequential: new Map(), delegated: new Map() };
  for (const row of dataset.measurements) {
    const group = groups[row.strategy];
    if (group.has(row.repetition)) throw new Error(`Duplicate ${row.strategy} measurement for repetition ${row.repetition}.`);
    if (row.acceptance_total < 1) throw new Error(`Repetition ${row.repetition} must include at least one acceptance check.`);
    if (row.acceptance_passed > row.acceptance_total) throw new Error(`Repetition ${row.repetition} has more passed acceptance checks than total checks.`);
    group.set(row.repetition, row);
  }
  const sequentialIds = [...groups.sequential.keys()].sort((a, b) => a - b);
  const delegatedIds = [...groups.delegated.keys()].sort((a, b) => a - b);
  if (sequentialIds.length < 3) throw new Error("At least three paired repetitions are required per strategy.");
  if (JSON.stringify(sequentialIds) !== JSON.stringify(delegatedIds)) throw new Error("Sequential and delegated measurements must have the same repetition ids.");

  const repetitions = sequentialIds.map((id) => ({ repetition: id, sequential: groups.sequential.get(id), delegated: groups.delegated.get(id) }));
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const comparison = (value) => {
    const seq = repetitions.map((pair) => value(pair.sequential));
    const del = repetitions.map((pair) => value(pair.delegated));
    if ([...seq, ...del].some((item) => item === undefined)) return { sequential_median: null, delegated_median: null, paired_median_delta_percent: null, missing: true };
    const pairedDelta = repetitions.map((pair) => {
      const before = value(pair.sequential);
      const after = value(pair.delegated);
      return before === 0 ? (after === 0 ? 0 : undefined) : ((after - before) / before) * 100;
    });
    return {
      sequential_median: median(seq),
      delegated_median: median(del),
      paired_median_delta_percent: pairedDelta.some((item) => item === undefined) ? null : median(pairedDelta),
      missing: false,
    };
  };
  const quality = (row) => row.acceptance_passed / row.acceptance_total;
  const qualityDelta = repetitions.map((pair) => (quality(pair.delegated) - quality(pair.sequential)) * 100);
  const summarize = (rows) => ({
    success_rate: rows.filter((row) => row.success).length / rows.length,
    acceptance_pass_ratio: rows.reduce((sum, row) => sum + row.acceptance_passed, 0) / rows.reduce((sum, row) => sum + row.acceptance_total, 0),
    retries_median: median(rows.map((row) => row.retries)),
  });
  const sequentialRows = repetitions.map((pair) => pair.sequential);
  const delegatedRows = repetitions.map((pair) => pair.delegated);

  return {
    schema_version: 1,
    scenario_id: dataset.scenario_id,
    repository_revision: dataset.repository_revision,
    host: dataset.host,
    host_version: dataset.host_version,
    repetitions: repetitions.length,
    quality: {
      sequential: summarize(sequentialRows),
      delegated: summarize(delegatedRows),
      median_paired_acceptance_delta_percentage_points: median(qualityDelta),
    },
    duration_ms: comparison((row) => row.duration_ms),
    tokens_input_output: comparison((row) => row.input_tokens + row.output_tokens),
    reasoning_tokens: comparison((row) => row.reasoning_tokens),
    cost_usd: comparison((row) => row.cost_usd),
    retries: comparison((row) => row.retries),
    interpretation: "Negative paired deltas mean the delegated strategy used less of that metric. Quality must not decrease; host-reported token and cost measurements are not independently verified.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    if (!process.argv[2]) throw new Error("Usage: npm run benchmark:delegation -- <evaluation.yaml>");
    const dataset = loadYaml(resolve(process.cwd(), process.argv[2]));
    process.stdout.write(`${JSON.stringify(analyzeEvaluation(dataset), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
