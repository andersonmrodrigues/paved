# Rules

A rule is a reusable constraint with a reason, a scope, a severity and a way to verify
compliance. Schema: `schemas/rule.schema.yaml`. Template: `templates/rule.yaml`.

## Layout and identity

| Layer | Location | Id prefix |
|---|---|---|
| Core | `core/rules/<category>/<name>.yaml` | `core.<category>.<name>` |
| Adapter | `adapters/<category>/<adapter>/rules/<category>/<name>.yaml` | `adapter-<adapter>.<category>.<name>` |
| Project | `.paved/rules/<category>/<name>.yaml` | `project.<category>.<name>` |

Core categories: `architecture`, `security`, `quality`, `testing`, `performance`.
Projects may add categories (for example `domain`); the Core does not.

## Resolution

1. Collect Core, adapter and project rules. Ids are unique across layers because the
   prefix names the layer.
2. Apply `.paved/overrides/overrides.yaml`: a project may change the severity of, or
   disable, a Core or adapter rule, always with an owner and a reason. Rules with `overridable: false`
   cannot be overridden. Adapters and project rules add constraints; they never modify
   another layer's rule. An override whose `target_sha256` no longer matches the rule is
   not applied until a human re-confirms it, so the rule applies at full strength.
3. A rule applies to a change when every selector in `applies_to` matches (paths,
   workflows, change types, adapters). An empty `applies_to` applies everywhere.

## Enforcement

`enforcement.mechanism` says who detects a violation (`automated` check, the `agent`, or
human `review`). `enforcement.layer` says where the rule is enforced today, using the
Gardener priority order. A rule enforced only by `rule` or `documentation` is a candidate
for promotion to a stronger layer.

## What belongs in the Core

A Core rule must hold for any well-built repository regardless of domain or technology.
Anything that depends on a language or framework goes into an adapter. Anything that
depends on the project goes into `.paved/rules/`.
