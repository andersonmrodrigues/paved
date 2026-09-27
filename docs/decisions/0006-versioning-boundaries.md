# 0006. Versioning boundaries

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The Core, the document format, adapters and generators change at different rates. One
version number for all of them would force unnecessary upgrades or hide
incompatibilities.

## Decision

- Independent versions: Core (SemVer), document API (`apiVersion: paved/v1`), adapters
  (SemVer + `requires.core`), generators (SemVer, recorded in provenance).
- Project Context, overrides and generated data are versioned by reference (VCS, digests,
  provenance), not by numbers.
- Within an API version, fields are never removed and meanings never change; a breaking
  schema change requires a new API version and a migration.
- Consumers declare ranges; `.paved/paved.lock` records exact versions and digests.
- While the Core is `0.x`, minor versions may break, and are recorded in the changelog.

## Consequences

- Adapters and the Core can release independently.
- Compatibility is checkable from declared ranges and the lock.
- Several version numbers must be understood by maintainers.

## Alternatives considered

- **Single version for everything.** Rejected: an adapter fix would force a Core release.
- **No API version, only Core SemVer.** Rejected: documents could not declare which
  format they follow.

## References

- [Kubernetes API deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)
- [SemVer 2.0.0](https://semver.org/)
- [versioning](../concepts/versioning.md)
