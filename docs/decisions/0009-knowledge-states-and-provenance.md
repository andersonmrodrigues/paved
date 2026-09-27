# 0009. Knowledge states and provenance

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Generated Project Context mixes facts read from code, facts stated by humans, guesses,
gaps and contradictions. Agents treat all text as fact unless told otherwise.

## Decision

- States: KNOWN (`observed`, `declared`), INFERRED, UNKNOWN (`unknowns`), CONFLICTING
  (`conflicts`), STALE (computed from source hashes, never stored).
- Review status is orthogonal to state.
- Provenance is per document, with identified sources (`file`, `revision`, `human`,
  `url`, `command`) and hashes; managed blocks and conflicts cite source ids.
- Inferred and observed documents must carry provenance (schema-enforced).

## Consequences

- "Why does Paved believe this?" is answerable for every generated block.
- Staleness is detectable without a service.
- Per-block citation is coarser than per-sentence; accepted as the maintainable unit.

## Alternatives considered

- **Per-sentence provenance.** Rejected: too heavy to maintain.
- **Stored STALE flag.** Rejected: a stored staleness flag is itself stale.

## References

- [traceability](../concepts/traceability.md)
