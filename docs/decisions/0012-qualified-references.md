# 0012. Qualified references and namespaces

- **Status:** Accepted
- **Date:** 2026-09-27
- **Amends:** [0003](0003-composition-and-overrides.md) (identity rule)

## Context

Rules and tools had qualified ids (`core.security.no-secrets-in-source`), but skills and
workflows were referenced by bare, globally unique names (`root-cause-analysis`,
`release`). Two formats meant two resolution rules, overrides keyed by different fields
(`id` for rules, `name` for skills and workflows), and no way for a project to replace a
Core skill under the same name, because global uniqueness forbade it even after the Core
skill was disabled. Context areas (`project.domain`) also looked like qualified ids.

## Decision

- Rules, tools, skills and workflows are all identified by `<namespace>.<path>`:
  three segments for rules, tools and skills (`core.debugging.root-cause-analysis`), two
  for workflows (`core.bug`). Namespaces: `core`, `adapter-<name>`, `project`.
- The field a reference appears in fixes the kind. No URI schemes, no kind prefix.
- Every reference, including override targets, uses the qualified id. Overrides key every
  entry by `target` and require an `owner`.
- Short skill and workflow names must be unique only within a project's effective set.
- Visibility follows the layer order: Core → core; adapter → core and itself; project →
  anything. Overrides never target project content.
- Context areas are plain registry keys (`domain`, `feature-map`).

## Consequences

- One format and one resolver (`cli/lib/references.ts`) for all composable artifacts.
- "Disable the Core skill, add a project skill with the same name" is possible.
- Breaking change to skill and workflow documents, overrides, evidence and context areas
  (allowed within `0.x`).
- `SKILL.md` keeps the short name the Agent Skills specification requires, so the short
  name must still be unique among active skills; that check belongs to composition.

## Alternatives considered

- **URIs (`paved://core/skill/…`).** Rejected: the kind is already known from the field,
  and the extra text can disagree with it.
- **Keep bare names for skills and workflows.** Rejected: two formats and no namespace
  for adapters.
- **Namespace per repository name.** Rejected: a project's own name does not matter to
  resolution; `project` is always the local layer.

## References

- [references](../concepts/references.md)
- [Kubernetes API groups](https://kubernetes.io/docs/concepts/overview/kubernetes-api/#api-groups-and-versioning)
