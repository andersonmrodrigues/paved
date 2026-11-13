---
name: profiling
description: >-
  Measure a performance baseline and locate its bottleneck before changing code. Use when investigating latency, throughput, memory, CPU, I/O or cost, or when a performance check or budget fails; use a specialized frontend or backend skill once the bottleneck is located.
---

# Profiling

## When to use

In the `discovery` phase of a `performance` run, where it produces the baseline, and
whenever a performance claim needs a number, including in a `feature` that adds a budget. The layer-specific skills (`backend-performance`,
`frontend-performance`) depend on this one for measurement.

## Required context

None is required. Useful: performance budgets and benchmarks in the verification
profile, and the architecture context for the affected path.

## Preconditions

- The target metric and workload are defined: what is measured, under what input, and
  what "better" means. If not, define them with a human first.
- A measurement can be taken in an environment representative enough to trust.

## Procedure

1. **Define the measurement** following
   [references/measurement-protocol.md](references/measurement-protocol.md): metric,
   statistic, workload, environment, warm-up and repetitions.
2. **Measure the baseline** and its run-to-run variance before changing anything.
3. **Profile** to locate where time or resources go. Do not optimize from intuition.
4. **Pick the largest contributor** and form one hypothesis about it.
5. **Change one thing.** Measure again under the same workload and environment.
6. **Keep the change** only if the improvement exceeds the variance and behavior is
   unchanged (run the behavior checks too).
7. **Repeat** until the target is met or the remaining gains are not worth the
   complexity, then report as in
   [examples/measurement-report.md](examples/measurement-report.md).

In a `performance` run, steps 1 to 4 end discovery: write the baseline as a
measurement record (`schemas/performance-measurement.schema.yaml`, `stage: baseline`)
with at least three samples, the method, what limits the numbers and the hypothesis.
Step 5's measurement is the `after` record, taken with exactly the same metric and
method. Paved compares the two sample sets and decides whether the gain clears the
noise; never edit samples after recording them.

## Tools

None from the Core. Profilers and benchmark runners are declared in `.paved/tools/` or
supplied by adapters.

## Rules

`core.performance.measure-before-optimizing` is this skill's contract.

## Verification

Required: `performance` — the measurement of baseline and result. Recommended: `unit`
and `integration`, to show behavior did not change.

## Evidence

Baseline and result measurements with workload and environment, and non-regression check
results.

## Completion criteria

- The target is met, or the evidence explains why it cannot be with a reasonable change.
- Baseline and result were measured the same way.
- Behavior checks pass.

## Failure modes

| Failure | Signal | Response |
|---|---|---|
| Noise mistaken for gain | Improvement within variance | Increase repetitions or discard |
| Different workload | Before and after measured differently | Re-measure both the same way |
| Micro-optimizing the wrong path | Profile shows the change is not on the hot path | Revert; go back to the profile |
| Unrepresentative environment | Numbers differ wildly from those reported | State the environment; ask for a better one |

## References

- [references/measurement-protocol.md](references/measurement-protocol.md): how to
  define and take a trustworthy measurement.
- [examples/measurement-report.md](examples/measurement-report.md): a synthetic report.
