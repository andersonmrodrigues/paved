# Generators

Generators turn a consumer repository into **materialized Project Context** and into
**proposals** for project-owned configuration. The Phase 08 development runtime lives
in `cli/lib/generator-runtime.ts`; the contracts remain in this directory.
Architecture, domain, product, integrations, feature map, verification and the
Checkstyle subset of Rules are experimental. Skills and tools remain contracts: the
runtime inspects their sources but emits no proposal without explicit, schema-safe
procedure or capability evidence.

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
- A conflict appears in the runtime result with a proposal path. The production
  `paved generate` and `paved status` diff interface belongs to Phase 10.
- The runtime stores each generated Markdown body and its hash in
  `.paved/generated/state/baselines/`. If that state is missing (it is not committed),
  it proposes changes to edited blocks rather than assuming they are untouched.
  It accepts a baseline only when its hash matches
  the document's inline `provenance.output_sha256` and the block still matches the
  baseline. The state is disposable and ignored by Git.

## Phase 08 runtime

The **Generator Contract** is `generator.yaml` plus `GENERATOR.md`: the promised inputs,
outputs, dependencies and safety rules. The **Generator Runtime** is the shared
execution and ownership mechanism in `cli/lib/generator-runtime.ts`. A **Generator
Implementation** is the area-specific extraction logic invoked by that runtime. The
**Consumer** is the external repository whose `.paved/` files receive results.
**Observed state** records what exists; **desired state** requires independent
project policy; **enforced state** requires a mechanical check. The runtime does not
collapse these categories.

`initializeConsumer(coreRoot, consumerRoot, projectName)` creates a valid manifest when
absent and refreshes a stale `local-core` lock. The lock records exact Core, adapter and generator versions
and local content digests computed from sorted relative paths and file-byte hashes.
The Git, Java, Quarkus, Angular and PostgreSQL adapters are available. The caller
reviews the manifest before adopting it as project policy.

`runGenerators(coreRoot, consumerRoot)` loads and schema-validates all nine contracts,
topologically orders dependencies, validates the manifest, discovers bounded source
sets, analyzes them, validates each output, checks ownership and the trusted baseline,
then writes or proposes. Required source or dependency failures stop the affected
generator and are recorded in `.paved/generated/state/last-run.json`; independent
generators may still run. The returned result contains source paths and hashes,
generator versions, statuses, unknown topics, conflicts and proposal paths.

Discovery skips `.paved/`, nested agent worktrees, dependencies, build output, secret
environment files, symlinks and files above 1 MiB. File identifiers are relative
paths; SHA-256 hashes cover raw file bytes, without filesystem metadata. Each
generator then selects the source kinds it understands. No external AI API is used.

The current implementation records **implemented** structure and **observed** code
signals. Existing code does not establish desired architecture, product requirements,
project rules, skills or recommended tools. Documentation and enforcement are separate
sources of authority; missing intent becomes `unknowns`. Generated context starts
`unreviewed`. The runtime does not yet perform semantic inference.

The verification proposal is a draft `VerificationProfile` with observed package
script names in comments and a `GeneratedArtifact` sidecar. It does not approve any
script as a check. A project owner must define Tool and Check bindings before adopting
a profile. The Rules generator proposes only Maven Checkstyle configurations bound to
the `validate` phase with a local configuration file; each proposal has a sidecar and
still needs human adoption. Skills and tools emit no speculative proposals in this pilot.

The Apecatus pilot exercises this API against an external repository. Portable synthetic
fixtures in `tests/generators/runtime.test.ts` protect discovery, provenance, safe
regeneration, route IDs, uncertainty and secret value exclusion. The Core has no
dependency on the Apecatus path.

See `docs/concepts/ownership-and-regeneration.md` for the full ownership model.

Phase 09 passes resolved adapter evidence to Project Context generators. The
Architecture, Domain, Integrations, Product and Feature Map generators consume
capabilities by ID, with adapter identity and source hashes in provenance.
No coexistence of technologies proves a runtime connection or project policy.
