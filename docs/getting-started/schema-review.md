# Schema review

This records the schemas pass at that point in the roadmap. For the current
implementation state and next milestone, see the [README](../../README.md).

What the schemas and contracts pass defined, which decisions it made, and what it left
open. The schemas make Paved documents **well formed and internally consistent**; they
do not make them correct. No schema or check here can tell whether a rule is wise, a
feature description is true, or a test exercises the claim it supports. Paved is still
not production ready: there are no CLI commands, generator or runner, and nothing has been used on
a real consumer repository.

## Starting point

The [architecture pass](architecture-review.md) left eleven schemas that worked but
disagreed in places: rules and tools had qualified ids while skills and workflows had
bare names; overrides keyed entries by `id` or `name` depending on the list; provenance
lived inside `common.schema.yaml` next to unrelated primitives; `apiVersion` was a
`const` in every schema, so a newer document failed with a generic field error; generated
files without a `provenance` field had no way to record where they came from; managed
block end markers were written two ways. This pass resolved those conflicts in place
rather than adding a second model.

## Research

| Source | Influence |
|---|---|
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | Dialect; `$id`/`$ref` composition; conditional constraints |
| [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) | Artifact versions; ranges must name full versions |
| [Kubernetes API conventions](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md) | One `apiVersion` for a group of kinds; additive changes within a version |
| [Agent Skills](https://agentskills.io/specification) | `SKILL.md` frontmatter untouched; Paved metadata in `skill.yaml` and sidecars |
| YAML frontmatter convention | Context documents keep metadata in frontmatter |
| [SLSA](https://slsa.dev/spec/v1.0/provenance), [in-toto](https://in-toto.io/) | Recorder independence; observations bound to a revision |
| Protocol Buffers / Avro evolution | Never reuse a removed name; readers reject what they do not understand |

Details: [schemas](../concepts/schemas.md#influences).

## Schemas

Sixteen files in `schemas/`, each with valid and invalid fixtures:

| Schema | Status in this pass |
|---|---|
| `manifest` | `schema_definitions`, `project.owners` added |
| `skill`, `workflow` | Qualified `id` replaces `name`; references by id |
| `rule` | Severity semantics documented (only `error` blocks); workflow scope by id |
| `tool` | Unchanged in shape; credentials explicitly excluded |
| `verification` | Optional `tool` per check |
| `evidence` | `inconclusive`, `human` artifact recorder, required revision and rule severity, profile reference, environment |
| `feature` | Actors, typed entrypoints, data, dependencies |
| `adapter` | Adapter dependencies with version ranges; `title` |
| `project-context` | Renamed from `context`; `technology` area; plain area keys |
| `override` | Renamed from `overrides`; `target` + required `owner` for every entry |
| `provenance` | **New.** The one provenance definition |
| `generated-artifact` | **New.** Sidecar metadata for generated files |
| `generator` | Outputs declare `metadata` (`inline` or `sidecar`) |
| `lock`, `common` | Shared primitives consolidated (reference formats, adapter and generator ids, change types, line ranges) |

## Key decisions

| Topic | Decision | Where |
|---|---|---|
| References | Qualified ids `<namespace>.<path>` for rules, tools, skills, workflows; field gives the kind; no URIs | [references](../concepts/references.md), [ADR 0012](../decisions/0012-qualified-references.md) |
| Namespaces | `core`, `adapter-<name>`, `project`; closed list; visibility follows layer order | [references](../concepts/references.md) |
| Versioning | One API version for all kinds; checked before the schema; newer → update, older → migrate | [versioning](../concepts/versioning.md) |
| Compatibility | Core lists supported API versions; projects and adapters declare Core ranges; lock pins | [versioning](../concepts/versioning.md) |
| Composition | `common` and `provenance` are shared definitions, never depending on document schemas | [schemas](../concepts/schemas.md#composition) |
| Generated metadata | Inline where the schema has `provenance`, sidecar otherwise | [ADR 0013](../decisions/0013-generated-artifact-metadata.md) |
| Evidence strength | Agent-recorded reviews support nothing; `minimum_recorder` enforced | [verification](../concepts/verification.md) |
| Overrides | No replace; owner and reason required; never on project content | [inheritance](../concepts/inheritance.md) |
| Manifest scope | No technology, context, capability or override sections; each has a source of truth elsewhere | [contracts](../concepts/contracts.md#manifest-core-project) |

## Validation strategy

Layered, each assuming the previous passed: version → schema → reference → semantic →
compatibility → freshness ([schemas](../concepts/schemas.md#validation-layers)). The
first four are implemented as library code and tested; compatibility and freshness are
specified for the CLI. Structural validity (layer 2) is kept separate from semantic
coherence (layers 3–4), and neither is correctness.

## Tests

`npm run check` passes: strict type check and 181 tests. New coverage:

- every schema has valid and invalid fixtures (74 schema fixtures), each invalid one
  failing for a stated reason: missing required fields, bad enums, bad versions and
  ranges, bad reference formats, overrides without owner, generated provenance without
  output hash, sidecars naming `human`;
- `apiVersion` handling (missing, malformed, newer, older, unsupported);
- the `$ref` graph between files is acyclic;
- reference resolution over all Core content, the templates and 8 reference fixtures
  (unknown targets, Core → project, adapter → other adapter, overrides of project content);
- provenance citations and managed block grammar (11 fixtures);
- evidence semantics for self-reported reviews, inconclusive checks and recorder policy;
- inline generator metadata only where the output schema has provenance.

No linter is configured.

## Unresolved decisions

- **Effective set assembly.** Reference resolution works on any set of documents, but no
  code yet assembles a project's effective set (locked Core, adapters, `.paved/`,
  overrides applied). Short-name uniqueness and duplicate-override detection depend on it.
- **Adapter name uniqueness across categories** is assumed by the `adapter-<name>`
  namespace but not enforced; it needs an adapter registry.
- **Durable evidence location** (PR, CI artifact) is still open.
- **Human approval records** for gates have no format.
- **Public schema URLs.** `$id`s are URNs; publishing them needs a domain.
- **Semver range grammar** is a pattern, not a parser; the CLI will need a real range
  implementation and the pattern may need to follow it.

## Future work

1. CLI `paved validate` over a consumer `.paved/`, wiring layers 1–4 together.
2. Effective-set assembly and the remaining composition checks.
3. Freshness (`paved status`): recompute source and output hashes.
4. Migration tooling, first needed when `paved/v2` exists.
5. A schema-diff check against the last release to classify changes automatically.
