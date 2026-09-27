# Generators

Generators turn a consumer repository into **materialized Project Context** and into
**proposals** for project-owned configuration. All generators are at status `contract`:
their inputs, outputs and behavior are specified; none is implemented yet.

Each generator is a directory with `generator.yaml` (schema:
`schemas/generator.schema.yaml`) and `GENERATOR.md` with these sections: Input, Output,
Preconditions, Sources analyzed, Strategy, Limitations, Unknown information, Avoiding
invention, Change detection.

| Generator | Writes | Ownership of output |
|---|---|---|
| `project-context/architecture` | `.paved/project/architecture/` | generated-reviewed |
| `project-context/domain` | `.paved/project/domain/` | generated-reviewed |
| `project-context/product` | `.paved/project/product/` | generated-reviewed |
| `project-context/integrations` | `.paved/project/integrations/` | generated-reviewed |
| `project-context/feature-map` | `.paved/project/feature-map/` | generated-reviewed |
| `verification` | `.paved/generated/proposals/verification/` | disposable (proposal) |
| `rules` | `.paved/generated/proposals/rules/` | disposable (proposal) |
| `skills` | `.paved/generated/proposals/skills/` | disposable (proposal) |
| `tools` | `.paved/generated/proposals/tools/` | disposable (proposal) |

## Rules every generator follows

1. **Write only where allowed.** Output paths must resolve to `generated-reviewed` or
   `disposable` in the Core manifest's `consumer_layout`. Rules, verification, tools,
   skills, overrides and the manifest are project- or human-owned, so generators only
   *propose* changes to them under `.paved/generated/proposals/`. A test enforces this.
2. **Trace everything.** Every generated document carries a `provenance` block
   (`schemas/provenance.schema.yaml`): generator, version, timestamp,
   source ids and available hashes, source revision when available, output hash, review
   status. Markdown
   documents are `ContextDocument`s: their YAML frontmatter holds `confidence`,
   `unknowns`, `conflicts` and `provenance`, and each managed block cites the ids of the
   sources it was derived from. Output that cannot embed provenance (proposals) gets a
   `<file>.paved.yaml` sidecar of kind `GeneratedArtifact`; each output declares which
   (`metadata: inline | sidecar`).
3. **Unknown stays unknown.** When a fact cannot be read from a source, the generator
   records an `unknown` with the reason and, when useful, a question for a human. It
   never fills gaps with plausible text.
4. **Mark confidence.** Facts read directly from sources are `observed`; facts derived by
   reasoning are `inferred` and start `unreviewed`.
5. **Never destroy human knowledge.** Regeneration follows the merge strategy below.
6. **Deterministic where possible.** Detection (files, manifests, configuration) is done
   by code. Language models are used only for summarizing, and their output is
   `inferred`.

## Regeneration and merge strategy

```text
regenerate(file):
  new := generate()
  if file does not exist                         → write new
  if file is still generator-managed and output hash matches file body
                                                 → untouched by humans: overwrite with new
  else (a human edited it)
     markdown with managed blocks                → replace only blocks whose previous
                                                   content matches a trusted baseline
     anything else                               → do not write; put new in
                                                   .paved/generated/proposals/<same path>
                                                   and report a conflict
```

- Human text outside managed blocks is never touched. A human "adopts" a block by
  deleting its markers; from then on it is human-owned text. A reviewed document with
  no managed blocks receives proposals rather than direct replacement.
- A conflict is reported by `paved generate` and `paved status` with a diff between the
  current file and the proposal. Resolution is a human decision.
- The last generated output of each file is kept in `.paved/generated/state/` so that a
  three-way diff (last generated, current, new) is possible. If that state is missing
  (it is not committed), the generator must propose changes to edited blocks rather than
  assume they are untouched. The block markers contain no hash; Phase 08 must define
  how a trusted baseline is recorded and matched before implementing block replacement.

See `docs/concepts/ownership-and-regeneration.md` for the full ownership model.
