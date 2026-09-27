# Extensibility

Paved is extended mostly by adding files that follow a schema. It has no plugin API and
does not plan one for `paved/v1`: every extension point below is either declarative data
or an executable with a contract, so it can be validated without running foreign code
inside the CLI.

## Extension points

| Extension point | Who | Mechanism | Validated by |
|---|---|---|---|
| Skills, workflows, rules, tools (Core) | Core maintainers | Filesystem + declarative (`*.yaml` + Markdown) | Schemas, Core tests |
| Check types | Core maintainers | Declarative: `core/verification/registry.yaml` and the `checkType` enum | Registry sync test |
| Custom check types (`x-*`) | Projects | Declarative: profile entries | Schema; they support no claims until registered in the Core |
| Document kinds | Core maintainers | A new schema + manifest entry + `KIND_TO_SCHEMA` | Schema tests |
| Adapters | Adapter maintainers | Filesystem + declarative (`adapter.yaml`, `provides`) | Adapter schema; quality bar in `adapters/README.md` |
| Project rules, skills, tools, workflows | Projects | Filesystem in `.paved/` | Schemas (via `paved doctor`) |
| Modifying inherited content | Projects | Declarative: `overrides.yaml` | Overrides schema; composition checks |
| Verification | Projects | Config: `.paved/verification/profile.yaml` | Schema |
| Generators | Core maintainers | Executable with a contract (`generator.yaml`) | Schema; write-permission test |
| Tools | Everyone (by layer) | Executable with a contract (tool YAML: inputs, safety class) | Schema; runtime checks later |
| CLI commands | Core maintainers | Code in `cli/` | Tests |

## What is deliberately not extensible

- **The CLI.** No command plugins. A capability either belongs in Paved (and is added
  to the CLI) or is a project tool with a contract. Plugins would let consumers run
  arbitrary code during validation, which is exactly the step that has to be trusted.
- **The lifecycle phases.** Workflows select and gate phases; they cannot invent new
  ones. The phase list is small on purpose, and every tool that reasons about workflows
  depends on it.
- **Claim types.** They drive the assessment of evidence. A new claim type is a Core
  change with a registry update, not a project extension.
- **Arbitrary patches.** Kustomize-style patches to inherited documents were rejected
  in favor of typed override operations ([ADR 0003](../decisions/0003-composition-and-overrides.md)).
- **Third-party generators.** Generators write into the consumer's `.paved/`. Until the
  write model has been exercised, only Core generators exist.

## Organization-wide conventions

An organization with many repositories will want shared rules and skills that are not
universal enough for the Core. In `paved/v1` the way to do this is an adapter-shaped
package: versioned, built from the organization's own sources, selected in each
project's manifest. Whether that deserves its own layer (between adapters and projects)
is an open decision; it would need its own identity prefix and precedence.

## Adding something

- To the Core: [evolving the Core](../maintenance/evolving-the-core.md).
- An adapter: [adapters/](../../adapters/README.md).
- To a project: [integrating a repository](../getting-started/integrating-a-repository.md).
