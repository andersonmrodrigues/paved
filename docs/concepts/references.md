# References and namespaces

How one Paved document points at another, and how identifiers from the Core, adapters
and a project avoid colliding. Decision record:
[ADR 0012](../decisions/0012-qualified-references.md).

## Reference forms

Paved has five kinds of reference, each with one format. The format is chosen by what is
referenced, not by the document that does the referencing.

| Referenced thing | Format | Example | Validated by |
|---|---|---|---|
| Composable artifact (rule, tool, skill, workflow) | Qualified id `<namespace>.<path>` | `core.debugging.root-cause-analysis` | Schema (format), `cli/lib/references.ts` (existence, visibility) |
| Something in the same document (claim, check, source, gate) | Local id | `unit`, `build-file` | Schema (format), library (existence) |
| A project-local name (feature, profile check) | Name | `checkout`, `unit` | Schema (format) |
| A file | Repository-relative path | `.paved/verification/profile.yaml` | Schema (no absolute paths, no `..`) |
| A registry entry (check type, evidence kind, context area) | Registry key | `unit`, `reproduction`, `feature-map` | Schema enum, kept in sync with the registry by a test |

Adapters (`languages/<name>`) and generators (`project-context/domain`) are packages,
not composable artifacts, and use their own path-like ids.

## Qualified ids

```
<namespace>.<category>.<name>     rules, tools, skills   core.security.no-secrets-in-source
<namespace>.<name>                workflows              core.bug
```

Every segment is lowercase kebab-case. The kind is **not** part of the id: the field a
reference appears in fixes the kind (`skill.tools` holds tool ids, `workflow.phases[].skills`
holds skill ids, override `rules[].target` holds rule ids). Kind-prefixed ids or URI
schemes (`skill://…`) were considered and rejected: every field already knows its kind,
so a scheme would be redundant text that can disagree with the field.

The same qualified id is used in every place an artifact is named: its own `id`, other
artifacts that use it, evidence that records it, and overrides that modify it. There is
no second, short form for references.

## Namespaces

| Namespace | Owner | Defined in |
|---|---|---|
| `core` | The Paved Core | `core/` in this repository |
| `adapter-<name>` | The adapter `<category>/<name>` | The adapter package |
| `project` | The consumer repository | `.paved/` |

Adapter names are unique across categories (there is no `languages/x` and
`frameworks/x`), so `adapter-<name>` is unambiguous. The namespace list is closed in
`paved/v1`; `common.schema.yaml#/$defs/namespace` enforces it.

Short names of skills and workflows (the last segment) must be unique within the
**effective set** of a project, because agents discover skills by their `SKILL.md`
name. A project may therefore disable `core.debugging.root-cause-analysis` and add
`project.debugging.root-cause-analysis`; having both active is an error.

## Visibility

References follow the dependency direction of the layers:

| A document in… | May reference |
|---|---|
| `core` | `core` |
| `adapter-<name>` | `core`, `adapter-<name>` |
| `project` (and project-only kinds: evidence, verification profile, overrides) | anything in the effective set |

Overrides may target `core` and `adapter-*` content, never `project` content: a project
edits its own files directly.

## Resolution

`cli/lib/references.ts` extracts every qualified reference from a document
(`referencesIn`), indexes the ids of an effective set (`indexArtifacts`) and reports
unknown targets, visibility violations and overrides of project content
(`resolveReferences`). Tests run it over all Core content, the templates and the
fixtures in `tests/fixtures/references/`. The CLI will run it over a project's effective
set; that set (Core at the locked version, selected adapters, `.paved/`) is not assembled
by any code yet.

## Examples

```yaml
# .paved/overrides/overrides.yaml
skills:
  - target: core.debugging.root-cause-analysis   # rule, skill or workflow, by list
    action: disable
    owner: platform-team
    reason: Replaced by project.debugging.root-cause-analysis.
```

```yaml
# .paved/workflows/hotfix/workflow.yaml
id: project.hotfix
phases:
  - phase: context
    skills: [project.debugging.root-cause-analysis, core.discovery.context-discovery]
```
