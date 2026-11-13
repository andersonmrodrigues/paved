# Performance

## When to use

Something is measurably slow, or a metric (latency, throughput, memory, CPU, I/O, cost)
should improve while behavior stays the same. If behavior must change too, or a new
budget is added as a requirement, use `feature`; if the code is wrong rather than slow,
use `bug`. When the user only wants to know why something is slow, use `investigation`.
Without a metric and a workload there is nothing to measure: the context phase asks.

`core.performance.measure-before-optimizing` is the contract, and Paved holds the run
to it: no plan before a baseline, no completion without an after measurement that
repeats the baseline's method and beats its spread.

## Phases

- **context:** pin down the metric, its unit and direction, the workload and the target.
- **discovery:** `profiling` measures before anything changes. Write the baseline as a
  measurement record (`kind` in `schemas/performance-measurement.schema.yaml`) at
  `.paved/generated/measurements/<run-id>-baseline.yaml` and advance with
  `--evidence <record>`. It holds the metric, the method (command, workload,
  environment, warm-up), at least three samples, what limits them and the hypothesis.
  Paved refuses it once a source or test file has changed since the run started, and
  records its digest with the source digest it describes.
- **planning:** the plan tests the one hypothesis and says how behavior stays the same.
  `backend-performance` or `frontend-performance` applies once profiling has placed the
  bottleneck; the other is recorded as not applicable.
- **implementation:** after the change, repeat the measurement with the same metric and
  method and advance with `--evidence` pointing at
  `.paved/generated/measurements/<run-id>-after.yaml`. Paved compares the sample sets
  itself: the improvement counts only when the after interquartile range clears the
  baseline's. Within noise or worse, the phase fails; add repetitions, reduce noise or
  amend the plan, never edit the samples.
- **verification:** behavior checks must pass on the code that was measured. If the
  source changed after the after measurement (for example while fixing a failing test),
  Paved reopens implementation so the measurement is taken again.
- **review:** the reviewer checks that the change matches the hypothesis and that the
  stated limits are honest: noise, warm-up, environment, and whether the command
  measured the real work or a proxy for it.

## Escalation

Stop and ask when no representative environment is available, when the only workload
that shows the problem is production, or when the target cannot be reached without a
behavior change; that change is a `feature`.
