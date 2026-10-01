# Performance

## When to use

Improving latency, throughput or resource usage, or fixing a performance regression.
`core.performance.measure-before-optimizing` governs the whole run: no change before a
baseline.

## Phases

- **context:** without a target the run cannot end; agree on one before measuring.
- **discovery / planning:** `profiling` owns the measurement. A profile, not intuition,
  picks what to change.
- **implementation:** the phase lists the server-side and client-side skills; activate
  the one the profile points to and record the other as not applicable. Both continue
  the measurement `profiling` started instead of starting a new one.
- **verification:** the `comparable-measurement` gate rejects numbers taken under other
  conditions than the baseline.
- **review:** a gain within run-to-run variance is not a gain. Complexity added for a
  small gain may be rejected.

## Escalation

Stop and ask when no representative environment is available to measure in, or when
reaching the target requires an architectural change.
