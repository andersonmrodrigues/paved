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
  or Core checkout. The temporary workspace retains only a resolved Git `HEAD`
  marker when available, so adapter detection and generated provenance match a
  real run without copying the repository's object database, configuration or
  transient Git files.
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

`init` does not edit application source files. It maintains a delimited Paved block in
the root `AGENTS.md`, creating the file when it is missing and never changing text
outside the block.

When the project is a git working tree and `AGENTS.md` is neither tracked nor ignored,
`init` first returns a required decision asking whether to version it:

- `track` writes the block as usual; committing the file is left to the team.
- `keep-local` adds `/AGENTS.md` (anchored at the project's path in the repository) to
  the clone's `info/exclude`, resolved with `git rev-parse --git-path info/exclude` so
  every linked worktree shares it. It never edits `.gitignore`, which would itself be a
  tracked change, and it never adds the pattern twice.

The decision is optional, so setup never waits on it: `init` writes the block right away
and the agent presents the question in the same turn. Answer `keep-local` before the next
commit if the file must stay out of version control. A tracked
or already-ignored `AGENTS.md` is never asked about, and outside git the block is
written without a question. `paved update` only refreshes an existing block and never
creates the file, so it asks nothing.

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
