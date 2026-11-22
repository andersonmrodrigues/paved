# `paved verify` and contract-only `paved evidence`

`paved verify` is implemented as an explicit, shell-free local runner. It runs
only the checks listed in `.paved/verification/profile.yaml` through declared Tool
and ToolImplementation documents, then records sanitized evidence.

`paved evidence ...` remains **contract-only**. Evidence validation, show and list
subcommands are described by contracts but are not executable CLI commands yet.

## Inputs

- `.paved/verification/profile.yaml`
- Check documents referenced by that profile from Core, selected adapters and the
  project
- Tool and ToolImplementation documents required by those Checks
- The local repository revision/worktree state used for evidence metadata

The runner does not infer checks from package scripts, CI files or arbitrary CLI
arguments.

## Supported flags

- `--project <dir>`: select the consumer root.
- `--adapter <id>`: repeatable content-root selector for adapter checks/tools;
  when omitted, adapters are read from the manifest.
- `--changed`: select checks using their `applies_to` globs against staged, unstaged
  and untracked files. Checks without globs always run. A tracked Paved configuration
  change runs all checks; generated state is excluded. Pass `--base <ref>` with
  `--changed` to include commits since the merge base. Without it, committed branch
  changes are not included. A Git working tree is required. With `--base`, a failing
  Check is also compared with the merge base (see "Pre-existing failures" in the
  verification failure concept).
- `--lock-wait <seconds>`: when another operation holds the project lock, wait up to
  this long (0 to 3600) instead of failing at once. If the holder recorded a run for
  the same change and configuration, that record is returned instead of running the
  Checks again; otherwise the Checks run once the lock is free.
- `--task <slug>`: attach the resulting evidence paths and status to an explicitly
  selected open task. Verification fails before running checks if the task is absent
  or completed, and fails if evidence cannot be attached.
- `--json`: render the structured result.
- `--help`: show command help.

Selectors, `--check`, `--profile`, `--workflow`, `--dry-run` and raw
shell commands are not supported by the current CLI.

## Reuse

Before running anything, `verify` looks for the newest record made for the same
change: the same revision and working tree fingerprint, or the same `change.tree_id`
(the Git tree of the content on disk, so a record made before a commit is reused for
the commit that captures the same content), the same profile digest and the same
`configuration_sha256` (a digest of the resolved Checks, Tools, ToolImplementations,
the Checks the `--changed` scope selects and which declared environment requirements
are present). When that record is complete and verified, and still validates, it is
returned with `data.reused: true` and no Check runs. A `warning` record is reused only
for the same `--base`. Any other newest record, including a failed one, means the
Checks run again, so an earlier pass never hides a later failure. A changed file,
Check or Tool, a scope that selects other Checks, or a requirement that appeared or
disappeared always runs the Checks.

## Ordering, environment and warnings

Checks run in profile order, except that a Check runs after every Check in its
`depends_on`. A dependency cycle or a dependency missing from the profile is a
configuration error before anything runs. A Check whose dependency did not pass (or
was not skipped) is `blocked` with `blocked_by`, not run on stale inputs.

A Check whose `environment.requires` names a file or variable that is absent is
`blocked` with `missing_environment` and `PAVED_CHECK_ENVIRONMENT_UNAVAILABLE`. Only
existence is tested: file contents and variable values are never read by Paved. The
declared variables are passed to the Check's process, and their values are redacted
from its log.

The result is `warning` instead of `failed` when every remaining problem is a
pre-existing failure, an environment-blocked Check or a Check blocked only by those,
and everything else is verified. `data.unproven` lists them with their `reason`
(`pre-existing`, `environment-unavailable` or `dependency-unproven`); each also
appears in the diagnostics. `data.checks` gives every Check's id, status, output
reference and, for a failure, a short excerpt of its failing lines.

## Outputs and mutations

Successful or failed configured verification writes sanitized logs and validated
evidence under `.paved/generated/evidence/`. Output is bounded, keeping the start and
the longer end of each stream, where test runners print their summary, and sanitized; raw
argv, environment values, stack traces and process error objects are not printed.

Each approved ToolImplementation is invoked with `spawn(executable, argv, { shell:
false })`. Unlisted executables or scripts are never scanned or run.

## Exit codes

- `0` when every configured required check completes and the evidence assessment
  is verified.
- `1` for `warning`: nothing new failed, but some Checks are unproven (see above). The
  JSON `status` is `"warning"`.
- `2` for unsupported flags or unexpected arguments.
- `3` for environment launch failures, such as a missing executable.
- `4` for invalid profiles, checks, tools, implementations or Tool inputs.
- `7` for missing profiles, empty profiles, unresolved checks/tools,
  unauthorized tools, failed/time-out checks or insufficient evidence.
- `8` when another operation holds the lock (after `--lock-wait`, if given).
- `9` for unexpected internal failures.
