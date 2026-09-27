# 0004. Generated vs human-owned knowledge

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Generators draft Project Context, and humans correct it. Naive regeneration destroys the
corrections; never regenerating leaves context stale.

## Decision

- Every consumer path has one ownership value in `consumer_layout`: `human-owned`,
  `project-owned`, `generated-reviewed`, `disposable`, `tool-managed`.
- Generators write only `generated-reviewed` and `disposable` paths (enforced by a test).
  Changes to project-owned files are proposals.
- `generated-reviewed` content is regenerated with a merge strategy: overwrite only
  unedited files (output hash) or unedited managed blocks; otherwise write a proposal.

## Consequences

- Human knowledge cannot be destroyed by regeneration, by construction.
- Humans must review proposals; a repository that never does accumulates them.
- Block hashing and the review workflow still need a concrete implementation.

## Alternatives considered

- **Regenerate and let VCS diff show changes.** Rejected: relies on humans noticing
  lost edits in large diffs.
- **Never regenerate after first review.** Rejected: context goes stale.

## References

- [ownership and regeneration](../concepts/ownership-and-regeneration.md)
