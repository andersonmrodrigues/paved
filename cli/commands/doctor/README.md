# `paved doctor`

Diagnose problems with a repository's Paved setup and suggest fixes. Unlike `status`,
which reports state, `doctor` looks for things that are wrong.

## Checks

- Every `.paved/` document declares a supported `apiVersion` and validates against its
  schema.
- References resolve (`cli/lib/references.ts`): every qualified rule, skill, tool and
  workflow id used in skills, workflows, rules, evidence, profiles and overrides exists
  in the effective set and is visible to the referencing layer.
- Citations resolve (`cli/lib/provenance.ts`): sources cited by managed blocks and
  conflicts are declared, and managed blocks are well formed.
- Composition succeeds: no short skill or workflow name active in two layers; every
  override targets inherited content that is overridable; no two overrides on one target.
- Overrides whose `target_sha256` no longer matches are reported as *needs review*;
  overrides without a digest are reported as unverifiable.
- Every profile Check resolves to a Tool with one compatible ToolImplementation in the
  target environment;
  optionally runs the checks (`--run-checks`).
- The `AGENTS.md` Paved block is present and current.
- Paths in `.paved/` not described by the consumer layout are reported.

## Options

`--run-checks`, `--json`.

## Writes

Nothing. Each finding comes with a suggested command or edit.
