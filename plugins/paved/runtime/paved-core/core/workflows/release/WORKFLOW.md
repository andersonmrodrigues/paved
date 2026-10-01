# Release

## When to use

Preparing a versioned release of the repository's software. Publishing affects users and
shared systems, so a human always approves it; the agent prepares, verifies and hands
over.

## Phases

- **context:** the release procedure is project knowledge; find it in project tools and
  context. Do not assume a registry, tag format or branch model. Both preconditions are
  checked before this phase; without them the run is `blocked`.
- **discovery:** `core.repository.history` lists the changes since the previous release marker or
  marker; each should map to a changelog entry.
- **planning:** derive the version from the changes with the project's versioning
  scheme. Incompatible changes need the `breaking-change-accepted` approval.
- **verification:** run the whole profile, not only checks related to the last change.
- **completion:** publishing happens here, after `publish-approved`, because it must
  follow every check on the candidate. The post-release `runtime` check is part of this
  phase and is appended to the same evidence record before the run completes.

## Escalation

Stop and ask when any profile check fails, or when the release procedure is not
documented in the project.
