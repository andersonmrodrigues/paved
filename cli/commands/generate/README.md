# `paved generate`

Run generators to create or refresh Project Context and proposals.

## Behavior

1. Resolve generators and their `depends_on` order. Run all, or those named as arguments.
2. Skip generators whose outputs are fresh (no recorded source hash changed), unless `--force`.
3. Write outputs following the merge strategy in `generators/README.md`: overwrite
   untouched generated files, update managed blocks, and turn every other change into a
   proposal under `.paved/generated/proposals/` with a reported conflict.
4. Print a summary: written, unchanged, proposed, conflicts, new unknowns.

## Options

`[generator-id...]`, `--force`, `--dry-run`, `--json`.

## Writes

Only paths whose ownership is `generated-reviewed` or `disposable`.
