# Generators

Generators turn repository evidence into Project Context or reviewable proposals.
Each public generator contract is defined by its `generator.yaml` and
`GENERATOR.md`; the execution mechanism is an internal CLI implementation.

## Current generators

| Generator | Output | Ownership |
|---|---|---|
| `project-context/architecture` | `.paved/project/architecture/` | generated-reviewed |
| `project-context/domain` | `.paved/project/domain/` | generated-reviewed |
| `project-context/product` | `.paved/project/product/` | generated-reviewed |
| `project-context/integrations` | `.paved/project/integrations/` | generated-reviewed |
| `project-context/feature-map` | `.paved/project/feature-map/` | generated-reviewed |
| `verification` | `.paved/generated/proposals/verification/` | disposable proposal |
| `rules` | `.paved/generated/proposals/rules/` | disposable proposal |
| `skills` | `.paved/generated/proposals/skills/` | disposable proposal |
| `tools` | `.paved/generated/proposals/tools/` | disposable proposal |

## Guarantees and limits

- Outputs are based on bounded repository evidence and record their provenance.
- Missing or ambiguous evidence remains unknown; existing code is not treated as
  desired architecture or project policy.
- Context starts unreviewed. Project-owned rules, verification, skills and Tools
  are proposed for human review rather than installed as policy.
- Regeneration preserves human-owned content. Conflicts produce proposals instead
  of silently replacing edits.
- Adapter evidence contributes only when its provider is resolved. Ambiguous
  providers require an explicit selection in the consumer manifest.
- Static analysis does not execute project scripts or call external AI services.

Run all generators with `paved generate --project <repository>`, or select a
generator id. CLI invocation and ownership semantics are described in the
repository's user documentation.
