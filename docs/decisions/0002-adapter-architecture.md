# 0002. Adapter architecture

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Knowledge about a language, framework, infrastructure or database is shared by many
repositories but is not universal. It changes on the technology's schedule, not the
Core's.

## Decision

- An adapter is a directory `adapters/<category>/<name>/` with `adapter.yaml`, its own
  SemVer version and a `requires.core` range.
- Adapters only **add**: knowledge, skills, rules (`adapter-<name>.*`), tools and check
  suggestions. They cannot override or disable Core content, and cannot add workflows in
  `paved/v1`.
- Adapters must cite official sources and record `reviewed_at`.
- Projects select adapters explicitly in their manifest; detection only proposes.

## Consequences

- The Core stays technology-free and complete without any adapter.
- A wrong adapter cannot weaken Core rules.
- Adapters that need to change Core behavior must instead propose a Core change.
- Where adapters are published (this repository or separate ones) is still open.

## Alternatives considered

- **Adapters as overlays that can patch Core content.** Rejected: makes the effective
  Core depend on which adapters are installed and on their order.
- **Technology knowledge in the Core with conditions.** Rejected: violates domain and
  technology agnosticism; the Core would grow with every technology.

## References

- `adapters/README.md`
- [inheritance](../concepts/inheritance.md)
