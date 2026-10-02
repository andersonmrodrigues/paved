# Measurement protocol

A measurement is only evidence if someone else could repeat it and get a comparable
result. Record every item below with the measurement.

## Define

| Item | Question | Example (synthetic) |
|---|---|---|
| Metric | What is measured? | Response time of one operation; peak memory of one job |
| Statistic | Which summary? | Median and 95th percentile, not the mean alone |
| Workload | Which input, how much, in which mix? | 1000 requests, 80% reads, payloads of typical size |
| Environment | Where? | Machine or environment class, other load present, data volume |
| Warm-up | What is discarded first? | First 50 requests (caches, lazy initialization) |
| Repetitions | How many runs? | At least 5 runs; report the spread |
| Target | What counts as done? | 95th percentile below the budget in the profile |

## Measure

1. Use the same workload, environment and build settings for baseline and result.
   Diagnostic builds and debuggers change timings; measure without them.
2. Run the warm-up, then the repetitions. Keep the raw numbers, not only the summary.
3. Compute the spread between runs. A difference smaller than the spread is not a
   result.
4. Record anything that disturbed the runs (other processes, network hiccups) rather
   than silently dropping runs.

## Profile

- Sample, then drill down: a sampling profile of the whole operation first, then
  targeted measurement of the hot spot.
- Look at wall time and resource time separately: waiting (I/O, locks, remote calls)
  and computing need different fixes.
- Profile the representative workload, not a toy input; hot spots move with data size.

## Report

State the metric, statistic, workload, environment, warm-up, repetitions, baseline,
result, spread and the change that produced the difference. A number without these is a
claim, not evidence.
