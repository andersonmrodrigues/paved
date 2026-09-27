# `paved init`

Create the first local Paved state for a repository that does not already have a
`.paved/` directory.

## Inputs

- The selected project root (`--project <dir>` or the current directory).
- Files in the project root used for local adapter detection. Ignored entries such
  as `.git`, `.paved`, `.env*`, agent state directories, dependency/build output
  and worktrees are not used as generation sources.
- The local Core checkout that contains the executable.

## Supported flags

- `--project <dir>`: select the consumer root.
- `--dry-run`: report the initialization and generation plan without final writes
  to the consumer. When generation planning needs a copy, the CLI creates a
  temporary `paved-init-dry-run-*` workspace under the OS temp directory and
  removes it before returning; it does not write scratch data under the consumer
  or Core checkout.
- `--no-generate`: create manifest/lock state without running generators.
- `--json`: render the structured result.
- `--help`: show command help.

`--adapter` and positional selectors are not supported. Adapter selection is based
on local detection evidence.

## Outputs and mutations

A successful non-dry run writes:

- `.paved/manifest.yaml`
- `.paved/paved.lock`
- `.paved/.gitignore`
- generated project context/proposals and generator state unless `--no-generate`
  is present

`init` does not edit application source files. The current implementation does not
write an `AGENTS.md` block.

If `.paved/`, `.paved/manifest.yaml` or `.paved/paved.lock` already exists, `init`
validates the existing manifest/lock and then refuses to reset or update that
state. Use `paved status`, `paved doctor` or `paved update` instead.

## Exit codes

- `0` when initialization planning/application succeeds.
- `1` for non-blocking detection findings or generated proposals requiring
  human review.
- `2` for unsupported flags or unexpected arguments.
- `3` for environment failures such as an inaccessible project path or
  unresolved Core root.
- `4` for invalid existing Paved state or an already initialized consumer.
- `6` for generator failures during initialization.
- `8` for generator ownership conflicts caused by safe generation.
- `9` for unexpected internal failures.
