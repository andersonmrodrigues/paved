# Delegation evaluation protocol

Use this protocol to decide whether delegating a workload improves speed or cost
without reducing accepted quality. Paved does not call provider APIs; record usage from
the active Claude Code or Codex host and label it as host-reported.

## Paired run

1. Pin the repository revision, host, host version, model, effort, task brief, and
   verification commands. Use the same starting revision for both strategies.
2. Run the task sequentially and with a delegation graph. Do at least three paired
   repetitions per scenario; alternate which strategy runs first.
3. Have the same independent acceptance checks evaluate both results. Record each
   check as pass/fail and include the evidence location. Do not use the implementing
   agent's self-assessment as the quality score.
4. Record end-to-end elapsed milliseconds and total input/output/reasoning tokens,
   including the coordinator, every worker, retries, and integration. Record cost only
   where the host reports a comparable value and currency.
5. Compare paired medians for quality-check pass ratio, latency, total tokens, cost and
   retry count. Report missing measurements; do not infer absent token or cost data.

## Measurement record

Store measurements as YAML validated by `schemas/delegation-evaluation.schema.yaml`.
Pin the scenario id, repository revision, host and host version at the top level. Add
one row per strategy and repetition with the selected model and effort, success,
acceptance checks passed/total, input/output tokens, duration, retries and an evidence
reference. Include reasoning tokens and cost when the host reports them; omit them when
unavailable. Include coordinator and every worker in the delegated row totals. Preserve
the raw rows and referenced evidence so the summary can be rerun.

Run `npm run benchmark:delegation -- <evaluation.yaml>` to validate paired repetitions
and print JSON with strategy medians, success and acceptance ratios, and paired median
percentage changes for duration, input/output tokens, reasoning tokens, cost and retries.
Negative efficiency deltas mean the delegated strategy used less. Missing metrics are
reported as unavailable, not estimated. The checked-in fixture is synthetic test data,
not a measured benchmark result.

## Decision rule

Delegation is a win only when success rate and acceptance quality are not lower and at
least one target (latency or cost) improves across paired medians. Treat token usage as a separate
efficiency measure. If quality falls, measurements are not paired, or host usage is
missing, do not claim an overall win. Repeat after material host/model changes.
