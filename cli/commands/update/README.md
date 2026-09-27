# `paved update`

Refresh an initialized consumer's local lock and generated output against the
Core checkout that is running the CLI. Remote version resolution, downloads,
migrations and adapter override flags are not implemented.

## Inputs

- `.paved/manifest.yaml`
- `.paved/paved.lock`
- Local Core files and local adapter/generator contracts referenced by the
  manifest/lock
- Existing generated baselines and managed outputs when generator contracts changed

## Supported flags

- `--project <dir>`: select the consumer root.
- `--dry-run`: compute the update plan without writing.
- `--json`: render the structured result.
- `--help`: show command help.

`--adapter`, remote selectors such as `--to`, migration flags and positional
arguments are rejected.

## Behavior

1. Validate the manifest and require a valid existing lock.
2. Confirm the local Core version satisfies `paved.core` and selected local
   adapters satisfy manifest ranges.
3. Compare local Core, adapter and generator contract digests with the lock.
4. Run safe generation only for changed/new generator contracts.
5. Write `.paved/paved.lock` only after compatibility checks and required safe
   generation succeed.

## Outputs and mutations

A non-dry run may write `.paved/paved.lock` and safe generator outputs/proposals
under `.paved/project/` or `.paved/generated/`. It never changes the manifest,
project-owned files, application source, override files, `AGENTS.md`, or paths
outside the consumer `.paved/` layout.

`--dry-run` writes nothing and reports planned lock/generator changes.

## Exit codes

- `0` when no changes are needed or the local update succeeds.
- `1` for non-blocking findings or generated proposals requiring human review.
- `2` for unsupported flags or arguments.
- `3` for environment failures such as an inaccessible project path or
  unresolved Core root.
- `4` for missing/invalid manifest or lock, or incompatible Core range.
- `5` for unavailable/incompatible adapters or capability resolution failures.
- `6` for update/generation planning or application failures.
- `8` for human-edited or untrusted generated output that creates an ownership
  conflict.
- `9` for unexpected internal failures.
