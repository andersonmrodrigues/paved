# ADR 0019: Source-control capability ownership

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Core skills and the release workflow used `core.git.status`, `.diff` and `.log`.
Core also shipped Git command bindings. This made a repository-generic procedure depend
on one source-control technology and contradicted the adapter boundary.

## Decision

Core owns only the observations its current procedures require:
`core.repository.status`, `core.repository.diff` and `core.repository.history`.
They retain read-only safety, repository-read permission, local/CI/ephemeral environments,
bounded execution, revision-bound evidence and explicit failure when unavailable.
The input revision and range are opaque source-control identifiers; Core does not define
Git syntax or invoke a source-control command.

`adapters/infrastructure/git` owns the Git command bindings. Its `adapter-git` namespace
identifies each implementation, while each binding names the Core Tool it implements.
The existing resolver selects a single compatible adapter implementation or blocks when
none or more than one matches. There is no Git-specific resolution rule. An adapter is
selected by the consumer manifest and locked separately from Core.

This rename changes public Tool ids and required Skill/Workflow references. Changed
Skill and Workflow versions are bumped. The adapter requires the compatible Core minor
(`^0.2.0`); this version is marked unreleased until publication. Evidence revision and
working-tree digests keep their existing meanings.

## Consequences

- Core can describe repository work without requiring Git.
- A consumer with no compatible source-control binding sees an explicit unavailable Tool.
- Existing consumers using `core.git.*` need a deliberate migration when adopting the
  next Core minor release. No consumer migration runs during this change.
- The CLI can use its general Tool resolution library; a production adapter runner is
  still future work.

## Alternatives considered

- Keep Git bindings in Core as an exception: rejected because Core skills then require
  Git even when another source-control adapter could satisfy their needs.
- Build a larger source-control framework now: rejected because status, diff and history
  are the only current Core requirements.

## References

- [Boundaries](../concepts/boundaries.md)
- [Tool resolution](../concepts/tool-resolution.md)
- [Adapter contract](../../schemas/adapter.schema.yaml)
