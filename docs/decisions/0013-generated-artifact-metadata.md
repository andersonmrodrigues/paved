# 0013. Generated artifact metadata

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Generated knowledge must say where it came from and whether a human changed it
([ADR 0004](0004-generated-vs-human-owned.md), [ADR 0009](0009-knowledge-states-and-provenance.md)).
Context documents and feature entries have a `provenance` field. Other generator output
does not: a proposed `SKILL.md` must keep the Agent Skills frontmatter unchanged, and a
proposed rule has no provenance field and should not get one (it would be copied into
the adopted rule).

## Decision

- Provenance has one definition, `schemas/provenance.schema.yaml`, embedded where a
  schema allows it.
- Output that cannot embed it gets a sidecar `<file>.paved.yaml` of kind
  `GeneratedArtifact`: path, format, schema and API version of the file, ownership
  (`generated-reviewed` or `disposable`), what it is a proposal for, and provenance.
- Every generator output declares `metadata: inline` or `sidecar`; a test checks that
  inline output has a schema with a `provenance` field.
- Generated provenance must include `generator_version` and `output_sha256`; a sidecar
  cannot name `human` as the generator.

## Consequences

- Generated, human-edited and human-written files are distinguishable by tooling.
- Proposals double the number of files under `.paved/generated/proposals/`; they are
  disposable.
- A human who adopts a proposal copies the file, not the sidecar, and the adopted file is
  human-owned.

## Alternatives considered

- **Provenance field on every schema.** Rejected: pollutes human-owned documents and
  breaks the Agent Skills format.
- **A single index of generated files.** Rejected: one file every generator writes is a
  merge-conflict hotspot and drifts from the files it describes.

## References

- [ownership and regeneration](../concepts/ownership-and-regeneration.md)
