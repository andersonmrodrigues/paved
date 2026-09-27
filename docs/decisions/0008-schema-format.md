# 0008. Schema and document format

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Every Paved document must be validated by tooling and identifiable without guessing.

## Decision

- Every document has `apiVersion: paved/v1` and a `kind`; one validator picks the schema
  by kind.
- Schemas are JSON Schema draft 2020-12, authored in YAML, with URN ids
  (`urn:paved:schema:<name>:v1`) and cross-references by absolute URN.
- Validation runs in Ajv strict mode (except `strictRequired`, for conditional required).
- Markdown documents carry their machine-readable part in frontmatter
  (`ContextDocument`).

## Consequences

- A standard, widely supported schema language.
- URNs point to no domain that does not exist yet; a public URL can be added later.

## Alternatives considered

- **TypeScript types as the source of truth.** Rejected: ties contracts to one runtime.
- **Unversioned schemas.** Rejected: see ADR 0006.

## References

- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)
- [Kubernetes object model](https://kubernetes.io/docs/concepts/overview/working-with-objects/)
