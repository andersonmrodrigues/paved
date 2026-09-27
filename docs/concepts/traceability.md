# Traceability and knowledge states

Every piece of Project Context should answer: *why does Paved believe this?* This
document defines where truth comes from, the states a statement can be in, how
provenance is recorded and how freshness is computed. Decision record:
[ADR 0009](../decisions/0009-knowledge-states-and-provenance.md).

## Source-of-truth hierarchy

Different questions have different authorities. Paved does not rank all sources on one
scale; it asks which kind of truth a statement is about.

| Kind of truth | Question | Authority, strongest first | Where Paved keeps a copy |
|---|---|---|---|
| **Implementation truth** | What does the system do? | Running behavior and tests → source code → configuration | Nowhere authoritative. Project Context describes it and is corrected by it |
| **Business knowledge** | What should it do, and why? | Humans who own the product → their written decisions | `declared` statements in Project Context, with a `human` source |
| **Architectural intent** | How should it be structured? | Architecture decision records and declared boundaries → enforced checks | `.paved/project/architecture/`, project rules |
| **Agent procedure** | How should an agent work here? | Project overrides and rules → adapter content → Core content | `.paved/`, adapters, Core |

Consequences:

- When Project Context disagrees with the code about what the system *does*, the code
  wins and the context is stale or wrong.
- When the code disagrees with a human about what the system *should* do, neither wins
  silently: it is a `conflict` (possibly a bug) for a human to resolve.
- When code disagrees with declared architectural intent, the code is a violation, not a
  new truth. That is what boundary rules are for.

## Knowledge states

| State | Meaning | Represented as | Agent treatment |
|---|---|---|---|
| **KNOWN** | Read directly from a source (`observed`) or stated by a responsible human (`declared`) | `confidence: observed` or `declared` | Use it |
| **INFERRED** | Derived by reasoning from sources | `confidence: inferred` | A lead; confirm in the code first |
| **UNKNOWN** | Nobody has established it | An entry in `unknowns` (topic, reason, question) | Do not fill the gap; ask or record |
| **CONFLICTING** | Two sources disagree | An entry in `conflicts` (topic, ≥ 2 statements each citing a source, question) | Do not pick a side silently |
| **STALE** | A source changed since the statement was derived | **Computed, never stored**: a source's recorded `sha256` differs from the file's current hash | Treat as a hint; re-verify |

Review status (`unreviewed`, `reviewed`, `rejected`) is orthogonal: an inferred statement
can be reviewed and remain inferred ("a human agrees this is a reasonable reading");
a human who confirms it as fact changes it to `declared`.

STALE is not stored because storing it would itself go stale. Any tool can compute it
from the recorded hashes.

## Provenance

Provenance (`schemas/provenance.schema.yaml`, the only definition) is recorded per document:

```yaml
provenance:
  generator: project-context/domain   # or "human"
  generator_version: 0.1.0
  generated_at: 2026-01-01T00:00:00Z
  source_revision: 4f2c9e1
  sources:
    - { id: schema-def, type: file, location: path/to/definitions.ext, sha256: "…", lines: "10-42" }
    - { id: owner-note, type: human, location: product owner, review meeting 2026-01-01 }
  output_sha256: "…"
  review: { status: unreviewed }
```

Source types: `file` (repository-relative path), `revision`, `human`, `url`, `command`.
Each source has a local `id`. Statements inside a document cite those ids:

- A managed Markdown block: `<!-- paved:begin generated id=entities sources=schema-def confidence=observed -->`,
  closed by `<!-- paved:end generated -->`. `confidence` is optional and defaults to the
  document's.
- A conflict: each statement names the source it came from.
- A Feature document's `code.entrypoints` point at files and lines directly.

`cli/lib/provenance.ts` checks that every cited id is declared, that blocks are well
formed (no nesting, every block closed by a matching end marker) and that block ids are
unique. Output of a generator must record `generator_version` and `output_sha256`
(schema). Files whose format has no room for provenance get a
[sidecar](ownership-and-regeneration.md#traceability).

**Granularity.** Provenance is per document, with citations per block. Per-sentence
provenance was rejected: it multiplies the size of every document and humans stop
maintaining it. A block is the smallest unit a generator regenerates, so it is the
natural unit of citation.

**Answering "why does Paved believe this?"**: find the block or entry → read its source
ids → resolve them in the document's provenance → open the file at the recorded lines,
check whether the hash still matches (freshness), and see who generated or reviewed it.

## Freshness

| Signal | Detects | Computed from |
|---|---|---|
| Source hash mismatch | The source changed after the statement was derived (STALE) | `sources[].sha256` vs current file |
| Source missing | The source was deleted or moved | `sources[].location` |
| Output hash mismatch | A human edited the generated content | `output_sha256` vs current content |
| Revision distance | Context generated long ago in repository history | `source_revision` vs `HEAD` |
| Adapter age | Technology knowledge not re-confirmed recently | adapter `reviewed_at` |
| Generator version | Context produced by an older generator | `generator_version` vs installed |

`paved status` reports these; `paved generate` refreshes stale generated content
following the merge strategy in [ownership and regeneration](ownership-and-regeneration.md).
The thresholds (how old is too old) are open decisions.
