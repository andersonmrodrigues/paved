# `paved init`

Set up Paved in a repository that does not use it yet.

## Behavior

1. **Repository discovery.** Confirm the target is a repository root; refuse if `.paved/`
   already has a manifest (suggest `paved update` or `paved doctor`).
2. **Technology detection.** Evaluate every adapter's `detect` signals.
3. **Adapter resolution.** Propose matching adapters and ask the human to confirm
   (non-interactive: `--adapter <id>` flags, or none).
4. **Scaffold.** Create the consumer layout from the Core manifest: `.paved/manifest.yaml`
   from the template, `.paved/paved.lock`, empty project-owned directories, and the
   Paved block in the root `AGENTS.md` (added, never replacing existing text).
5. **Project context generation.** Run `paved generate` unless `--no-generate`.
6. **Verification setup.** Run the verification generator; the proposal is shown for the
   human to adopt into `.paved/verification/profile.yaml`.
7. **Validation.** Run `paved doctor`.

## Options

`--adapter <id>` (repeatable), `--core <range>`, `--no-generate`, `--dry-run`, `--json`.

## Writes

Only paths that do not exist yet, plus the delimited block in `AGENTS.md`.
