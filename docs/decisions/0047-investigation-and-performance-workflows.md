# ADR 0047: Investigation and performance workflows

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Two common kinds of request had no governed path. A question about the code ("why does
the export time out?") either went through `bug`, which aims at a fix and asks for plan
approval, or ran outside Paved with no record of what the answer rested on. A request to
make something faster ran as `refactor` or `feature`. Neither demanded a baseline before
the change, and neither checked that the gain was larger than the noise.

[ADR 0036](0036-intent-plan-execute.md) removed the `performance` workflow because nothing
executed it: the runner did not capture measurements, so its gates were only prose. It
also set the rule that a Core workflow ships only with the code that enforces it.

## Decision

Add two Core workflows, each with a gate module in `cli/lib/workflow-gates/`.

**`investigation`** is a new workflow and a new `change_type`, not an extension of
`context-discovery`. That is a skill and a fragment, and neither owns a run, a deliverable
or an end state. The workflow reuses the fragment in its discovery phase. It has no
`planning` or `implementation` phase, so it needs no plan approval. Read-only is enforced
in three layers:

- A workflow without an `implementation` phase may reach only `read-only` Tools, whether
  a phase lists them or an active skill or its required dependencies bring them.
  `assessReadOnlyTools` applies this when a workflow is authored and again when the
  runtime loads one in `loadContract`.
- The workflow's `read-only` Tool policy denies the Core's state-changing Tools in every
  phase, so the host sees the denial before any invocation.
- The gate module compares the run's source and test fingerprint with the one recorded
  at the start, in discovery and again in verification. An edit made outside any Tool
  blocks the run with `PAVED_INVESTIGATION_SOURCE_CHANGED`.

The deliverable is an answer document at `.paved/documents/research/<run-id>.md` with
`Answer`, `Claims` and `Recommendation` sections. Each claim is labeled `observed`,
`inferred` or `unknown`. Observed and inferred claims cite a `path:line`, a
`commit <sha>` or a `$ command`. Paved checks that line citations fall inside an
existing file, and that commits resolve. A change the answer recommends starts a new
intent; the investigation never authorizes it.

**`performance`** returns as a workflow, not a fragment. Baseline-before-change has to be
a gate, and [ADR 0046](0046-bounded-workflow-fragment-composition.md) keeps gates out of
fragments.

- Discovery accepts a `PerformanceMeasurement` record (new schema) only while the source
  is unchanged since the run started. The record holds the metric, the method, at least
  three samples, what limits them and the hypothesis.
- Implementation needs an after record with the same metric and method.
- Paved computes the verdict itself: an improvement counts only when the two sample sets'
  interquartile ranges do not overlap in the better direction. Otherwise the phase fails.
- Accepted records are bound by digest to the source fingerprint they measured.
  Verification reopens implementation if the code changed after it was measured, and
  blocks if a record was edited.
- Plan approval stays required.

To let a module own a shared phase, a module hook for `verification`, `evidence` or
`completion` now replaces the shared hook, and the module may call the shared hook itself.

`intent` offers both workflows through the existing classification. An ambiguous request
still produces a decision for the user, and agents are told to recommend rather than
choose when "it is slow" could mean either.

## Consequences

- ADR 0036's removal of `performance` is reversed. Its rule is kept: the workflow now
  ships with the code that enforces each gate. `incident` and `release` stay removed.
- `investigation` is a new `changeType` value. The precedent is the existing
  `performance` value and new check types, so it is classified as additive (Core minor).
  A project workflow that uses it needs this Core or later.
- Measurements are reported by the agent. Paved validates them, binds them to the code
  and decides the verdict, but does not run the benchmark. `$ command` citations are
  recorded as stated and not re-run.
- The Claude plugin package drops compiled TypeScript sources under `cli/` that have a
  `cli/build` twin. The runtime only loads the compiled files, and that keeps the
  package under its file ceiling.

## Alternatives considered

- **Extend `context-discovery` into a read-only mode.** Rejected: a skill has no run or
  end state, so nothing could refuse a write or certify the answer.
- **Performance as a fragment on `refactor`.** Rejected: a fragment cannot add the
  baseline and improvement gates, and `refactor` requires a passing test baseline, not a
  measurement.
- **Let the agent state the verdict.** Rejected: the improvement claim is the thing to
  prove, so Paved computes it from the samples.
- **Run benchmarks from a Check.** Deferred: benchmark commands are project-specific and
  slow. The record format leaves room for a `performance` Check to produce it later.

## References

- `core/workflows/investigation/`, `core/workflows/performance/`
- `cli/lib/workflow-gates/investigation.ts`, `cli/lib/workflow-gates/performance.ts`
- `schemas/performance-measurement.schema.yaml`
- [ADR 0036](0036-intent-plan-execute.md), [ADR 0046](0046-bounded-workflow-fragment-composition.md)
