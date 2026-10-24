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

Keep one row per scenario, strategy and repetition with: scenario id, strategy
(`sequential` or `delegated`), repetition, success, quality checks passed/total,
input/output/reasoning tokens, cost, duration, retries, host, model, effort, revision,
and evidence. Preserve raw rows alongside the summary so the comparison can be rerun.

## Decision rule

Delegation is a win only when acceptance quality is not lower and at least one target
(latency or cost) improves across paired medians. Treat token usage as a separate
efficiency measure. If quality falls, measurements are not paired, or host usage is
missing, do not claim an overall win. Repeat after material host/model changes.
