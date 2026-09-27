# Fixtures

Synthetic documents; none describes a real project.

- `schemas/<schema-name>/valid/*.yaml`: documents that must validate. Every schema has at
  least one. Documents with a `kind` are validated as a tool would (API version first,
  then the schema for the kind) and must sit in the directory of that schema; fragments
  without a kind (provenance) are validated against the directory's schema.
- `schemas/<schema-name>/invalid/*.yaml`: documents that must fail. Each declares
  `# expect-error: <text>`; the test asserts that some validation error contains that
  text, so a fixture cannot pass by failing for an unrelated reason.
- `evidence/sound|unsound/*.yaml`: schema-valid evidence records that the semantic
  assessment (`cli/lib/evidence.ts`) must accept or reject. A `# minimum-recorder: <x>`
  header sets the verification policy the record is assessed under. Unsound files name
  the rejection reason with `# expect-error: <text>`.
- `evidence/synthetic/*.yaml` and `verification/*.yaml`: reusable synthetic records,
  Check and profile covering completion status, partial verification, retries,
  performance and runtime observations.
- `references/valid|invalid/*.yaml`: multi-document YAML files resolved against Core
  content plus the file's own documents (`cli/lib/references.ts`). Invalid files declare
  `# expect-error: <text>`.
- `skills/valid|invalid/<name>/`: skill directories for the quality checks
  (`cli/lib/skills.ts`). Each invalid `skill.yaml` declares one or more
  `# expect-problem: <text>`.
- `skill-evidence/sound|unsound/*.yaml`: evidence records assessed against the Core
  skills they name in `producer.skills`. Unsound files declare `# expect-problem: <text>`.
- `workflows/valid|invalid/<name>/`: workflow directories (`workflow.yaml` + `WORKFLOW.md`)
  for `assessWorkflowQuality`. Each invalid `workflow.yaml` declares one or more
  `# expect-problem: <text>`. `project.data.purge` stands for a destructive tool.
- `workflow-runs/sound|unsound/*.yaml`: run records checked with `assessRun` against the
  Core workflow they name. Unsound files declare `# expect-problem: <text>`.
- `workflow-evidence/sound|unsound/*.yaml`: evidence records checked with
  `assessWorkflowEvidence` against `core.bug`.
- `provenance/sound|unsound/*.md`: context documents whose citations and managed blocks
  `cli/lib/provenance.ts` must accept or reject. Unsound files declare
  `# expect-problem: <text>` in their frontmatter.
