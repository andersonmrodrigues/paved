# `paved generate`

Run Paved generators against an initialized consumer, either all generators or a
selected set plus their dependency closure.

## Inputs

- `.paved/manifest.yaml`
- Local Core generator contracts
- Local adapter detections and manifest-selected adapters
- Repository files discovered by the generator runtime, excluding ignored source
  entries such as `.git`, `.paved`, `.env*`, dependency/build output and agent
  state directories
- Existing generated baselines and last-run state

## Supported flags and arguments

- `[generator-id...]`: optional generator selectors, for example
  `project-context/feature-map`. Dependencies run first.
- `--project <dir>`: select the consumer root.
- `--dry-run`: compute outputs/proposals without writing them or `last-run.json`.
- `--json`: render the structured result.
- `--help`: show command help.

`--adapter`, `--force` and unknown selectors are rejected.

## Outputs and mutations

A non-dry run may write generated-reviewed or disposable paths under
`.paved/project/` and `.paved/generated/`, proposals under
`.paved/generated/proposals/`, and `.paved/generated/state/last-run.json`.

Human-edited generated files are not overwritten; the new output is written as a
proposal and the command exits with a conflict category. New disposable proposals
that do not involve an ownership conflict are reported as findings. Application
source files are never modified.

`--dry-run` writes nothing to the consumer.

## Exit codes

- `0` when selected generation succeeds without findings.
- `1` for non-blocking adapter/generator findings or generated proposals
  requiring human review.
- `2` for invalid flags, arguments or generator selectors.
- `3` for environment failures such as an inaccessible project path or
  unresolved Core root.
- `5` for adapter/capability resolution failures.
- `6` for generator runtime failures.
- `8` for generated-content ownership conflicts.
- `9` for unexpected internal failures.
