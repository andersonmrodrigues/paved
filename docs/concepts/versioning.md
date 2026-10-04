# Versioning

Several things carry versions. Keeping them separate lets the Core, adapters and
projects evolve at their own pace while incompatibilities stay detectable. Decision
record: [ADR 0006](../decisions/0006-versioning-boundaries.md).

| What | Where declared | Format | Bumped when |
|---|---|---|---|
| **Core version** | `VERSION`, `manifest.yaml`, `package.json` (kept equal by tests) | SemVer 2.0.0 | Every Core release |
| **Document API version** | `apiVersion` in every Paved document | `paved/v<N>` | A breaking change to any schema |
| **Adapter version** | `adapter.yaml` `version` | SemVer 2.0.0 | Every adapter release |
| **Generator version** | `generator.yaml` `version`, copied into provenance | SemVer 2.0.0 | Output format or strategy changes |
| **Tool version** | Tool contract `version` | SemVer 2.0.0 | Capability meaning or compatible contract evolves |
| **ToolImplementation version** | Binding `version`; `contract` names supported Tool range | SemVer 2.0.0 | Binding behavior changes |
| **Plugin version** | `plugins/plugin-source.json`, projected into the plugin manifests and each plugin's `VERSION` | SemVer 2.0.0 | Plugin packaging, skills or launcher change |
| **Runtime version** | The `paved-core` Core version carried by the plugin (`scripts/bootstrap.json`) and pinned per repository in `paved.lock` `runtime` | Core SemVer | A Core release |

The rest is versioned by reference rather than by number:

| What | Versioned by | Why no number of its own |
|---|---|---|
| **Schemas** | `$id` (`urn:paved:schema:<name>:v1`) tied to the document API version; shipped in a Core release | A schema is the API; its version *is* the `apiVersion` |
| **Project Context** | The project's VCS history; `apiVersion` of each document; `provenance.source_revision` and `generator_version` | It changes with the code it describes |
| **Overrides** | The project's VCS history; `target_sha256` binds each entry to the target version it was written for | What matters is whether the *target* changed, not the override |
| **Generated data** | `generator_version` in provenance; nothing for disposable output | It can be regenerated from its inputs |
| **Lock** | Exact Core, adapter and available generator versions and digests | It *is* the resolution record |

The project declares requirements: `.paved/manifest.yaml` has an `apiVersion`, a Core
range (`paved.core`) and adapter ranges; `.paved/paved.lock` records exactly what was
resolved. The optional `generators` list identifies available contracts and their
digests; it does not mean each generator ran. The current local lock records the local
Core and each selected adapter by version and digest. Manifest
`capability_providers` resolves provider ambiguity without changing adapter versions, and
the lock's `capabilities` section records the resulting provider decisions;
remote distribution resolution is not implemented. `resolved_at` is metadata and does
not affect resolution, compatibility or staleness.

## Plugin and runtime versions

The plugin version identifies the installable package; the runtime version is the
Core version it bundles. They move independently: a launcher or skill fix bumps
only the plugin version, and a Core release bumps the runtime and, because the
bundled artifact changes, the plugin as well. A repository's `paved.lock` pins its
runtime by version, SHA-512 integrity and installed content digest, and that pin
wins over any plugin. A plugin carrying another runtime only reports
`PAVED_RUNTIME_UPDATE_AVAILABLE`; `update` adopts a newer one (and `runtime upgrade`
any one) through the Core's transactional update and `runtime rollback` restores the previous lock and runtime.
`plugins/provenance/` records both versions and every file digest of each plugin.

## Change classification

| Change to… | Compatible | Breaking |
|---|---|---|
| Schema | New optional field; new enum value in a field Paved writes; relaxed constraint | New required field; removed field or enum value; changed meaning; tightened constraint that rejects existing documents |
| Skill | Clearer wording; new optional context, tool, dependency or recommended check; new step that does not contradict existing ones | Removed or renamed; different purpose; new required context, tool, dependency or check type |
| Workflow | Clearer guidance; optional input, context, tool or recommended check | Removed or renamed; phase added or removed; new gate or approval; new required input, check type or evidence kind |
| Rule | Lower severity; narrower `applies_to`; clearer rationale | Removed or renamed; higher severity; wider scope; `overridable` changed to `false` |
| Capability meaning | Core registry `core/capabilities/registry.yaml`, versioned with Core | Change in the observation or operation promised to consumers |
| Tool contract | New optional input/output field | Removed/renamed; safety raised; required input added; capability meaning changed |
| Tool implementation | Internal fix within same contract | Required binding removed; compatibility range narrowed incompatibly; execution semantics changed |
| Consumer layout | New optional path | Path removed or moved; ownership changed; path made required |
| Adapter | New knowledge, skills, rules at severity below `error` | Removed content; new `error` rule; higher `requires.core` |

A change that makes a compliant consumer non-compliant is breaking even if no schema
changed. That is why a new gate or a stricter rule is breaking: it can turn a
previously complete task into an incomplete one.

## What happens on each kind of change

| Situation | Paved does |
|---|---|
| **Compatible change** | `paved update` within the range; revalidate; no human action |
| **Breaking change** | New Core major (or minor while `0.x`); outside existing ranges, so no project gets it without editing its manifest |
| **Migration** | Documents that require migration block `update`; automatic transforms are not implemented. |
| **Regeneration** | Needed when a generator's output format changes (`generator_version` bump) or its sources change (stale hashes). Follows the merge strategy; never a migration of human content |
| **Validation failure** | After update or migration, any invalid document stops the update and restores the previous lock ([failure handling](failure-handling.md)) |
| **Override target changed** | Subtractive overrides suspended until re-confirmed ([inheritance](inheritance.md)) |

## Core SemVer

- **Major:** a new document API version becomes required; a skill, workflow, rule or
  tool is removed or renamed; a rule's meaning changes so compliant projects may stop
  complying; the consumer layout changes incompatibly.
- **Minor:** new skills, workflows, rules, tools, optional schema fields, new
  check types, new generators; deprecations.
- **Patch:** wording and procedure fixes that do not change contracts.

While the Core is `0.x`, minor versions may contain breaking changes (SemVer rule for
initial development). Consumers should pin with `^0.<minor>.0`, which npm-style ranges
already restrict to that minor.

## Document API versions

Paved uses **one API version for all document kinds** (`paved/v1`), declared in every
document as `apiVersion`, like a Kubernetes API group. Schemas do not have independent
versions: `urn:paved:schema:<name>:v1` belongs to `paved/v1`. Alternatives (a version
per schema, or a `schemaVersion` field next to `apiVersion`) were rejected because a
project would have to track a compatibility matrix across a dozen kinds that always ship
together in one Core release.

| Version | Relationship |
|---|---|
| Core version (`0.1.0`) | A release. Declares which API versions it reads in `supported_api_versions` |
| API version (`paved/v1`) | The contract of all documents. Changes only on a breaking schema change |
| Schema `$id` (`…:v1`) | Identifies the schema of one kind within an API version |
| Artifact version | Adapters, generators, skills, workflows, Tools and ToolImplementations have one (SemVer). Other Core content is versioned by the Core release, project content by VCS, overrides by `target_sha256` |

### Reading a document

`checkApiVersion` (`cli/lib/schemas.ts`) runs before schema validation, so a version
problem is reported as one message instead of a list of unrelated field errors.

| `apiVersion` is… | Result |
|---|---|
| Supported | Validate against the schema for `kind` |
| Missing | Rejected: every Paved document declares one |
| Malformed (not `paved/v<N>`) | Rejected: not a Paved document |
| Newer than any supported | Rejected: *update Paved*. A reader never guesses the meaning of fields it does not know |
| Older than any supported | Rejected: *migrate the document* with the migration shipped by the Core that dropped it |
| Between supported versions but not listed | Rejected as unsupported |

### Evolving a schema

| Change | Classification | What happens |
|---|---|---|
| New optional field; new enum value in a field only Paved writes; relaxed constraint | Additive | Same API version; Core minor |
| New required field; removed field or enum value; tightened constraint; changed meaning | Breaking | New API version (`paved/v2`), or while the Core is `0.x`, a Core minor with a changelog **Breaking** entry |
| Renamed field | Breaking | Add the new field, deprecate the old one, remove it in the next API version. A removed field name is never reused with a different meaning |
| New enum value in a field a *consumer* writes and Paved branches on | Breaking for readers | Treated as breaking: an older reader would reject documents using it |

- **Migration policy.** A Core that introduces a new document API may ship a reviewed,
  deterministic migration in the typed Core migration registry. `paved update` applies
  exactly one known migration to a staged copy, validates every result against the
  candidate schema, and publishes documents and the lock in one transaction. Unknown,
  ambiguous or invalid migrations block the update and leave human-owned content
  untouched. Markdown migrations may change frontmatter but must preserve the body.
- **Deprecation.** A deprecated field stays valid, its schema `description` starts with
  `Deprecated:` and names the replacement, and the changelog records it. It is removed
  only with a new API version.
- **Pre-1.0.** While the Core is `0.x`, breaking schema changes stay within `paved/v1`
  and are marked **Breaking** in the changelog. `paved/v1` is frozen at Core `1.0.0`.

## Compatibility check

`paved update` and `paved doctor` report incompatibility when any of these fails:

1. The resolved Core version satisfies the project's `paved.core` range.
2. The project's `apiVersion` is in the Core's `supported_api_versions`.
3. Every adapter's `requires.core` accepts the resolved Core version.
4. Every adapter listed in another adapter's `requires.adapters` is present.
5. Every `.paved/` document validates against the resolved Core's schemas.

## Deprecation

Deprecated content stays for at least one minor release with a note in the changelog
and, for rules and skills, a pointer to the replacement. Removal happens in a major.

Exception (2.0.0): the 1.x agent commands and the `performance`, `incident` and `release`
workflows were removed without a deprecation release. See
[ADR 0036](../decisions/0036-intent-plan-execute.md).

## Skill versions

Each skill carries its own `version` and `status` in `skill.yaml`. A skill's major bump
means work that satisfied it before may not now (new required context, tool, dependency
or check type; changed purpose); minor adds optional context, tools, dependencies,
recommended checks or compatible steps; patch is wording. `experimental` skills stay
below 1.0.0 and `stable` skills are at 1.0.0 or above (schema). A deprecated skill
records `deprecation.since`, `migration` and, when there is one, `replaced_by`. A skill
major bump is a breaking Core change. Details: [skills](skills.md#versioning).

## Workflow versions

Workflows use the same model as skills: `version` and `status` in `workflow.yaml`,
`experimental` below 1.0.0, `stable` at 1.0.0 or above, and `deprecation` (`since`,
`migration`, optional `replaced_by`) when deprecated. A major bump means a run that
completed before may not now: a phase, gate, approval, required input, required check
type or required evidence kind added, or the class of change altered. Minor adds
optional inputs, context, tools or recommended checks. A run record names the workflow
version it ran, and `assessRun` rejects a record for another version.
