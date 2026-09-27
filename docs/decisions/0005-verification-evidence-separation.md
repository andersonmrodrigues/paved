# 0005. Separating claims from observations

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

An agent reporting that its own change works is not evidence. "It compiles" and "the
tests I chose pass" are routinely presented as proof of correctness.

## Decision

- Evidence records separate **claims** (typed: behavior, non-regression, structure,
  performance, security, documentation) from **observations** (checks, artifacts).
- Each claim type can only be supported by specific check types and artifact kinds
  (`core/verification/registry.yaml`). `build` supports nothing.
- Each observation records who observed it (`recorded_by`: agent, paved, ci) and the
  revision it ran against; mismatched revisions are rejected.
- Completion is decided by deterministic assessment (`decided_by`), not by the agent.
- Projects can require a minimum recorder in their verification profile.

## Consequences

- Self-reported results remain possible but are labeled.
- Real independence requires the Paved runner or CI integration, which do not exist yet.
- Evidence records are more verbose than a success message; templates keep them usable.

## Alternatives considered

- **Trust the agent's report.** Rejected: the failure mode Paved exists to prevent.
- **Require CI for everything.** Rejected for now: many useful local workflows have no CI
  access; the policy is left to projects.

## References

- [SLSA provenance](https://slsa.dev/spec/v1.0/provenance)
- [in-toto attestation framework](https://github.com/in-toto/attestation)
- [verification](../concepts/verification.md)
