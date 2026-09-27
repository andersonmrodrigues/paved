# Verification determinism

The same revision, inputs, environment and check definition should lead to the same
interpretation. A check declares `deterministic`, `controlled` or `nondeterministic`.
Controlled checks state how they pin random seeds, clocks, network responses or other
sources. Nondeterministic checks name their sources and controls; a single pass carries
less confidence. Common sources are timestamps, random data, external services,
eventual consistency, concurrency and environment drift.

Evidence records the revision and, for dirty working trees, a digest of uncommitted
changes. It records tool version, recorder and the environment facts needed to interpret
the result. A performance check records baseline, current value, direction, unit,
workload and project threshold. The assessor compares the values; it does not accept a
passing label that contradicts the numbers. Noise and varying workloads should produce
an inconclusive result or additional measurements, not a guessed pass.

The Core defines the comparison contract but no threshold, workload, runtime or
observability stack. Projects and adapters provide those values. See
[checks](checks.md) and [evidence](evidence.md).
