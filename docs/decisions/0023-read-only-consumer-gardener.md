# ADR 0023: Read-only consumer-scoped Gardener

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Evidence and generator state record failures and conflicts. Gardener finds recurrence
without turning existing repository behavior into policy or bypassing consumer ownership.

## Decision

Gardener reads validated local Evidence and Generator Runtime state for one consumer. It groups stable failure identities and returns deterministic observations and proposals. It never writes its analysis or any enforcement artifact. Human review events live in an optional human-owned document and cannot mark a proposal implemented before acceptance. Normal candidates remain consumer-scoped. An explicitly invoked comparison can return a review-only Core candidate, with generality and technology independence marked unknown; Core promotion is a separate human decision. Provenance reuses the existing source schema.

## Consequences

No lock, generated baseline, application source, or project-owned configuration can be corrupted by Gardener analysis. Repeated runs are idempotent. Historical analysis depends on retained Evidence; Generator Runtime exposes only its latest run. Reviewers still need to investigate root causes, implementation scope, and any Core generality.

## Alternatives considered

- Generate active Rules from frequent code: rejected because repetition does not establish intent.
- Maintain a global consumer registry: rejected because it violates isolation and machine independence.
- Persist Gardener output under generated state: deferred because a read-only result meets initial review needs without adding a writer or regeneration path.

## References

- `docs/concepts/gardener.md`
- `cli/lib/gardener.ts`
- `schemas/gardener-proposal.schema.yaml`
