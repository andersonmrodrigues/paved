# `paved update`

Move a repository to a newer Core or adapter version within, or after changing, the
ranges declared in `.paved/manifest.yaml`.

## Behavior

1. **Core update.** Resolve the newest Core version satisfying `paved.core`, and adapter
   versions satisfying their ranges.
2. **Compatibility check.** Confirm that the new Core supports the project's
   `apiVersion`, and that every adapter's `requires.core` accepts the new Core.
   Stop with exit code 1 on incompatibility, listing each conflict.
3. **Project context validation.** Validate all `.paved/` documents against the new Core's
   schemas.
4. **Override review.** Compare every override's `target_sha256` with the new target.
   Report mismatches as *needs review*; subtractive overrides stay suspended until a
   human re-confirms them (`paved update --confirm-override <target>` records the new
   digest). Report the Core changes that affect this project: changed rules, skills and
   workflows it uses, and new rules that now apply to it.
5. **Migration if necessary.** When the new Core has a newer `apiVersion`, apply its
   migration to project documents. Migrations run in `--dry-run` first and write only
   after confirmation; human-owned files are migrated only with explicit consent per file.
6. Refresh `.paved/generated/core/` (resolved Core cache), `.paved/paved.lock` and the
   `AGENTS.md` Paved block.

## Options

`--to <version>`, `--dry-run`, `--json`, `--confirm-override <target>`, `--yes` (accept migrations non-interactively;
never implied in CI).

## Writes

`.paved/paved.lock`, `.paved/generated/`, the `AGENTS.md` block; other files only through
confirmed migrations, and `target_sha256` in `.paved/overrides/overrides.yaml` only for
overrides a human confirmed. All writes happen after all checks; a failure leaves the
repository unchanged.
