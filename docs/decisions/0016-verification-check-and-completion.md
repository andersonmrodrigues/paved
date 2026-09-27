# 0016. Check definitions, revision-bound evidence and deterministic completion

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The original verification profile mixed available checks with their execution details,
and evidence relied on an agent-authored completion status. It could not represent
preconditions, bounded retries, flaky results or objective performance comparisons.
Required gaps were visible but could be treated as a completed task.

## Decision

- A `Check` document defines purpose, type, preconditions, expected verdict,
  environment needs, determinism and retry policy. It references a `Tool`, which owns
  the command. The profile lists check ids, and workflows and skills request types.
- Evidence carries a task plan and revision-bound check executions. Outputs and large
  artifacts are referenced using the existing provenance source model.
- `evaluateCompletion` recomputes completion, verification level, claim support and
  blocking reasons. A required type must pass for `complete`; a gap is never a pass.
- Disagreeing retry attempts are flaky and inconclusive. Performance verdicts are
  checked against recorded measurements and thresholds.
- The Core remains technology-agnostic. Adapters and projects supply commands,
  workloads, thresholds and environment identities.

## Consequences

Existing evidence and profiles need migration within the `0.x` release line. The
current library assesses records, while execution capture, artifact digest validation
and authenticated recorder identity await the CLI runner or CI integration. A
`partially-verified` record is a useful report but cannot complete a task with missing
required verification.

## Alternatives considered

- Inline commands in checks: rejected because they duplicate Tool contracts and make
  Core checks technology-specific.
- A single numeric rigor ladder: rejected because strength depends on the explicit
  claims and workflow requirements, not on reaching one universal test level.
- Treating accepted gaps as passed: rejected because acceptance records a conscious
  exception but cannot establish the missing observation.

## References

- [Verification architecture](../concepts/verification.md)
- [Checks](../concepts/checks.md)
- [Evidence](../concepts/evidence.md)
