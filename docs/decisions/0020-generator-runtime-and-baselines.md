# ADR 0020: Generator runtime and trusted regeneration baselines

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The nine generator contracts describe inputs and outputs but did not execute. Project
Context is generated and reviewed, so a rerun can destroy human knowledge unless it
can distinguish untouched generated content from edits. Block markers alone do not
prove that a block is unchanged. A real consumer also contains source patterns that
must remain observations rather than becoming project policy.

## Decision

The development runtime is a shared library in `cli/lib/`, which may depend on generator
contracts, schemas and adapters under the declared component graph. Contract documents
remain in `generators/`. Discovery is bounded by file kind, generator-specific filters
and source size. Repository-relative path plus raw content hash identifies each file.

Every generated context file records the existing provenance model. The runtime keeps a
disposable baseline of the previous Markdown body and its hash under
`.paved/generated/state/baselines/`. A block is replaceable only if the baseline hash
matches inline provenance and its current content matches the baseline block. Text
outside the block is preserved. Missing or mismatched baselines produce proposals.
YAML Feature entries use their inline output hash to detect edits. Project-owned files
receive proposals and sidecars, never direct writes.

Observed implementation, documented intent and mechanical enforcement remain separate.
Only an explicit Maven Checkstyle binding currently produces a Rule proposal. A package
script alone cannot become an approved check or recommended Tool.

## Consequences

- Regeneration is safe to rerun while disposable baseline state exists.
- Losing baseline state makes human-edited blocks require review rather than risking
  replacement.
- Source and output hashes explain staleness and edits; timestamps remain execution
  metadata and do not cause unchanged files to be rewritten.
- Technology-specific interpretation belongs in adapters; the runtime remains generic.

## Alternatives considered

- Trust block markers alone: rejected because a human can edit inside them.
- Store baseline only in provenance: rejected because an output hash cannot identify
  which block changed while preserving text outside blocks.
- Have generators write project policy directly: rejected by the ownership contract.

## References

- [Ownership and regeneration](../concepts/ownership-and-regeneration.md)
- [Generators](../../generators/README.md)
- [Provenance schema](../../schemas/provenance.schema.yaml)
