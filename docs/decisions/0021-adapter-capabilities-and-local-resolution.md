# ADR 0021: Adapter capabilities and local resolution

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Adapters need general detection, compatibility and evidence-provider behavior without
turning every detected script or CI file into an adapter.

## Decision

Extend the existing adapter manifest with repository-static capability providers.
Core defines capability meanings and consumers in a schema-validated registry.
Adapters provide deterministic signals and bounded evidence rules. Detection,
compatibility, dependency resolution, capability resolution and evidence collection
are separate functions in the shared `cli/lib/` runtime. The project manifest selects
adapter ranges and may select one provider for an ambiguous capability. The existing
local lock records exact adapter versions and digests. Existing Git Tool bindings remain.

The initial adapters are `infrastructure/git`, `technology/java`,
`technology/quarkus`, `technology/angular` and `technology/postgresql`. Quarkus depends
on Java. Maven belongs to Java build evidence. The framework emits observations and
provenance, never project policy. No remote distribution or production CLI is added.

## Consequences

Generators can consume resolved capability evidence while remaining independent of
concrete adapter IDs. Unsupported or irrelevant technologies can remain unmodeled.
Ambiguous providers produce diagnostics and require an explicit selection. The static
extractors identify declarations but do not prove runtime behavior or business intent.

## Alternatives considered

- Add technology conditionals to each generator: rejected because adapters would no
  longer own reusable interpretation.
- Create an adapter for every discovered file or command: rejected because discovery
  does not imply a Paved capability needs technology-specific knowledge.
- Replace the existing adapter and Tool contracts: rejected because Git bindings and
  consumer manifest/lock semantics already work.

## References

- `schemas/adapter.schema.yaml`
- `core/capabilities/registry.yaml`
- `cli/lib/adapters.ts`
- `docs/concepts/adapters.md`
