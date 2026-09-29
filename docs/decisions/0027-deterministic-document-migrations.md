# ADR 0027: Deterministic document migrations in local update

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

`paved update` previously treated every project document that failed the candidate
schema as `PAVED_UPDATE_MIGRATION_REQUIRED`, even when the compatibility change was
known and mechanically safe. Automatically guessing how to rewrite human-owned
documents would weaken the Core's ownership and rollback guarantees.

## Decision

Document migrations are typed Core contracts in `cli/lib/document-migrations.ts`.
Each migration declares an identifier, one source version, one destination version,
the supported document kinds, and a pure transformation. Selection requires exactly
one matching contract; unknown, ambiguous, malformed, or invalid results remain
blocking diagnostics.

Migrations run only against the staged `.paved/` copy. Every result is validated
against the candidate schema before generators or the lock are committed. The
transaction swaps the complete staged state, so a failed migration cannot publish a
partial document or an advanced lock. Markdown transformations operate on
frontmatter and preserve the body exactly.

The initial contract adopts legacy documents that omit `apiVersion` into `paved/v1`
when their kind is recognized and the resulting document satisfies its schema.
Documents with a malformed or newer explicit API version are never guessed or
rewritten.

## Consequences

Known compatibility changes no longer require manual intervention, while the safe
default remains a hard block. Migration metadata is reported without embedding
human document content in diagnostics. Adding a new migration requires a typed
contract and tests for selection, validation, idempotence and rollback.

## References

- [Versioning](../concepts/versioning.md)
- [Repository lifecycle](../concepts/repository-lifecycle.md)
- [ADR 0022](0022-consumer-lifecycle-and-atomic-local-update.md)
