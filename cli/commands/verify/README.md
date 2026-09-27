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
- `--json`: render the structured result.
- `--help`: show command help.

Selectors, `--check`, `--profile`, `--workflow`, `--changed`, `--dry-run` and raw
shell commands are not supported by the current CLI.

## Outputs and mutations

Successful or failed configured verification writes sanitized logs and validated
evidence under `.paved/generated/evidence/`. Output is bounded and sanitized; raw
argv, environment values, stack traces and process error objects are not printed.

Each approved ToolImplementation is invoked with `spawn(executable, argv, { shell:
false })`. Unlisted executables or scripts are never scanned or run.

## Exit codes

- `0` when every configured required check completes and the evidence assessment
  is verified.
- `2` for unsupported flags or unexpected arguments.
- `3` for environment launch failures, such as a missing executable.
- `4` for invalid profiles, checks, tools, implementations or Tool inputs.
- `7` for missing profiles, empty profiles, unresolved checks/tools,
  unauthorized tools, failed/time-out checks or insufficient evidence.
- `9` for unexpected internal failures.
