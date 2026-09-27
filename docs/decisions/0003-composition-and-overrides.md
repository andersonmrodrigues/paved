# 0003. Composition and overrides

- **Status:** Accepted; identity rule amended by [0012](0012-qualified-references.md)
- **Date:** 2026-09-27

## Context

Projects need to adjust inherited content: a rule too strict for them, a skill missing a
project step, a workflow needing an extra gate. Common mechanisms are copying and
editing (drift), shadowing by name (silent, order-dependent), or arbitrary patches
(Kustomize-style: powerful but unreviewable and fragile across versions).

## Decision

- Composition order is fixed: Core → adapters (dependency order, then id) → project →
  overrides.
- Identities never collide across layers (layer-prefixed ids, globally unique names).
  There is no shadowing; the only precedence is "an override beats its default".
- All modification of inherited content goes through `.paved/overrides/overrides.yaml`,
  with **typed operations**: rules `set-severity`/`disable`; skills `extend`/`disable`;
  workflows `extend`/`disable`. Each needs a reason.
- Rules can be marked `overridable: false`.
- Overrides may record `target_sha256`. When the target changes, subtractive operations
  are suspended and the override is flagged for review.
- The earlier `workflows.disabled` in the project manifest was moved into overrides, so
  there is one place for all modifications.

## Consequences

- Every exception to inherited behavior is in one file, with reasons, reviewable and
  countable across repositories.
- Some legitimate customizations need two steps (disable + add a new project skill or
  workflow).
- Composition checks (collisions, missing targets, digests) must be implemented in the
  CLI; they are specified, not built.

## Alternatives considered

- **Kustomize-style strategic merge or JSON patches.** Rejected: any field can change,
  patches break silently when the target changes, and reviewers cannot tell intent.
- **Shadowing by name.** Rejected: a file added in the wrong place silently replaces
  Core behavior.
- **Disable-by-manifest for workflows.** Replaced by override `disable` for consistency.

## References

- [Kustomize](https://kubectl.docs.kubernetes.io/references/kustomize/)
- [inheritance](../concepts/inheritance.md)
