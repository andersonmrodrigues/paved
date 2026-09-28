# Evolving the Core

How to change this repository without breaking consumers.

## Before any change

- Run `npm ci` once, then `npm run check` (strict type check and all tests).
- Ask: is this true for **every** repository, regardless of domain and technology? If
  not, it belongs in an adapter or in a consumer's `.paved/`, not here (Principle 2).

## Adding content

| To add | Do | Tests that will hold you to the contract |
|---|---|---|
| Skill | `core/skills/<category>/<name>/` with `SKILL.md` from `core/templates/skill.md` and `skill.yaml` from `core/templates/skill.yaml`: id `core.<category>.<name>`, `version: 0.1.0`, `status: experimental`. Detail in `references/`, examples in `examples/`, each listed in `references`. Bump the version of every skill you change ([skills](../concepts/skills.md#versioning)); add the skill to `core/skills/README.md` | `tests/skills/`, `tests/core/references.test.ts` |
| Workflow | `core/workflows/<name>/` with `WORKFLOW.md` and `workflow.yaml`, id `core.<name>`, `version` and `status`; quality fixtures in `tests/fixtures/workflows/` for new checks | `tests/workflows/`, `tests/core/references.test.ts` |
| Rule | `core/rules/<category>/<name>.yaml`, id `core.<category>.<name>` | `tests/core/rules-and-tools.test.ts` |
| Tool | `core/tools/<group>/<name>.yaml`, id `core.<group>.<name>` | `tests/core/rules-and-tools.test.ts` |
| Check | `core/verification/checks/<group>/<name>.yaml`, id `core.<group>.<name>`, referencing a safe Tool; no project command in the definition | `tests/verification/`, `tests/core/references.test.ts` |
| Check type | Entry in `core/verification/registry.yaml` **and** the enum in `schemas/common.schema.yaml` | `tests/schemas/` (sync check) |
| Capability | Add the technology-neutral meaning and concrete consumer to `core/capabilities/registry.yaml`; update its schema and tests when the contract changes | `tests/adapters/` |
| Adapter | `adapters/<category>/<name>/adapter.yaml` from the template, with official sources | schema validation |
| Generator | `generators/<id>/` with `GENERATOR.md` and `generator.yaml` | `tests/generators/` |
| Document kind | Schema in `schemas/`, entry in `manifest.yaml` `schemas`, entry in `KIND_TO_SCHEMA` in `cli/lib/schemas.ts`, template, valid and invalid fixtures in `tests/fixtures/schemas/<schema-name>/`. A shared definition without a kind goes in `schema_definitions` instead ([schemas](../concepts/schemas.md)) | `tests/schemas/` |
| Top-level directory | An entry in `components` in `manifest.yaml` with its `depends_on` | `tests/core/boundaries.test.ts` |
| Architectural decision | A record in `docs/decisions/` ([format](../decisions/README.md)) | review |

## Changing contracts

1. Decide whether the change is breaking (see [versioning](../concepts/versioning.md)).
2. Breaking schema changes need a new `apiVersion` and a migration plan; do not edit a
   released schema in a breaking way.
3. Add fixtures that pin the new behavior: an invalid fixture with `# expect-error:` for
   every new constraint.
4. Update the changelog under `[Unreleased]`.
5. If the change moves a boundary or changes how layers compose, write or supersede an
   ADR, and update [enforcement candidates](enforcement-candidates.md) when a check is
   added or planned.

## Releasing

1. Move `[Unreleased]` entries under a new version heading in `CHANGELOG.md`.
2. Update `VERSION`, `manifest.yaml` `version` and `package.json` `version` to the same
   value (a test enforces it).
3. `npm run check`.
4. Tag the release. The current source-checkout distribution is documented in the
   [README](../../README.md); update it if the release distribution changes.

## Receiving Gardener proposals

Proposals that target the Core must show that the problem is universal (incidents from
more than one repository or technology) and that no stronger enforcement layer fits.
Most proposals belong in a consumer or an adapter; redirect them there.
