# Ownership and regeneration

Generators must never silently destroy knowledge a human wrote. Paved achieves this with
an explicit ownership value for every consumer path (declared in the Core manifest's
`consumer_layout`) and a merge strategy that respects it.

## Ownership values

| Ownership | Written by | Regenerable | Paths |
|---|---|---|---|
| `human-owned` | Humans only | No | `AGENTS.md` (outside the Paved block), `.paved/manifest.yaml`, `.paved/overrides/` |
| `project-owned` | Humans, or agents doing a reviewed task | No | `.paved/rules/`, `.paved/verification/`, `.paved/tools/`, `.paved/skills/` |
| `generated-reviewed` | Generators draft, humans review and edit | Yes, preserving human edits | `.paved/project/` |
| `disposable` | Tools | Yes, freely | `.paved/generated/` |
| `tool-managed` | The CLI only | Yes, deterministically | `.paved/paved.lock` |

## Artifact ownership

| Artifact | Owner | Source of truth | Generated? | Editable in the consumer? | Overridable? | Deletable? | Updated by |
|---|---|---|---|---|---|---|---|
| Core skills, rules, workflows, tools | Core maintainers | Core repository at the locked version | No | No | Yes, through overrides | No (disable instead) | `paved update` |
| Adapter content | Adapter maintainers | Adapter at the locked version | No | No | Rules and skills, through overrides | No (remove the adapter) | `paved update` |
| Project architecture, domain, product, integrations | The project | The code (implementation), humans (intent, business) | Drafted | Yes; human edits are preserved | No (edited directly) | Yes, then regenerated as unreviewed | `paved generate` + human review |
| Feature map | The project | The code | Drafted | Yes | No | Yes | `paved generate` + human review |
| Project rules | The project | `.paved/rules/` | Proposed only | Yes | No (edit directly) | Yes | Humans, agents in reviewed tasks |
| Verification profile | The project | `.paved/verification/` | Proposed only | Yes | No | Yes (checks become gaps) | Humans |
| Project tools, skills, workflows | The project | `.paved/tools/`, `skills/`, `workflows/` | Proposed only | Yes | No | Yes | Humans |
| Overrides | The project's humans | `.paved/overrides/` | No | Yes | — | Yes (inherited content applies again) | Humans; the CLI records `target_sha256` |
| Lock | The CLI | Manifest ranges + distribution | Yes | No | No | Yes (re-resolved) | `paved init`, `paved update` |
| Generated artifacts (cache, proposals, state) | Tools | Their inputs | Yes | No | No | Yes | Any run |
| Evidence | The agent/runner that produced it | Observations of one change | Yes | No | No | Yes locally; the durable copy is with the review | `paved verify`, agents |

Generators may write only `generated-reviewed` and `disposable` paths. A Core test
enforces this for every generator contract. To change a `project-owned` file, a
generator writes a proposal under `.paved/generated/proposals/` and a human adopts it.

## Traceability

Every generated document records provenance (schema: `provenance.schema.yaml`):
generator id and version, time, available source revision and source hashes, a hash
of the generated output, and review status (`unreviewed`, `reviewed`, `rejected`).
Markdown documents carry it in their frontmatter (schema: `ContextDocument`); YAML
documents under `provenance`. Output whose format has no place for it (a proposed
`SKILL.md`, a proposed rule) gets a sidecar `<file>.paved.yaml` of kind
`GeneratedArtifact`; each generator output declares `metadata: inline` or `sidecar`. The full model is in [traceability](traceability.md).

This makes three things possible:

- **Staleness:** a recorded source hash that no longer matches means the document may be outdated.
- **Edit detection:** an output hash that no longer matches means a human edited the file.
- **Audit:** every generated statement points back to where it came from.

## Merge strategy

On regeneration of a `generated-reviewed` file:

1. **File absent** → write it.
2. **File unchanged since generation** (output hash matches) and still under generator
   management → overwrite. A reviewed file whose managed blocks were removed is
   human-owned and receives a proposal instead.
3. **File edited by a human:**
   - Markdown with managed blocks (`<!-- paved:begin generated id=... -->` …
     `<!-- paved:end generated -->`): regenerate a block only when its previous content
     matches a trusted baseline. Text outside blocks, and blocks a human edited, are left alone.
   - Otherwise: do not write. Store the new output as a proposal under
     `.paved/generated/proposals/<same path>` and report a **conflict**.
4. If no trusted block baseline is available, write a proposal for edited blocks; the
   marker itself contains no hash. Phase 08 keeps the previous Markdown body and hash
   under `.paved/generated/state/baselines/`. A baseline is trusted only when its hash
   matches inline provenance and the existing managed block matches the stored block.
   The runtime then replaces that block and preserves text outside it.
5. Conflicts are shown by `paved generate` and `paved status` as a diff; a human
   resolves them. If `.paved/generated/state/` still has the previous generated output,
   the diff is three-way (previous, current, new).

A human takes full ownership of a block by removing its markers, or of a whole file by
setting its review status to `reviewed` and removing managed blocks.

## Open points

How review status is updated (by hand, or via a `paved review` command), and whether
`.paved/generated/state/` should be committed for teams that regenerate often, are
listed as open decisions in the
[bootstrap review](../getting-started/bootstrap-review.md).
