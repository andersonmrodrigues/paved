# `paved status`

Report a consumer repository's Paved state without changing files.

## Inputs

- The selected project root.
- `.paved/manifest.yaml` and `.paved/paved.lock` when present.
- Local Core and adapter contracts available from the executable's Core checkout.
- Generator last-run state, proposals/conflicts and verification profile presence.

## Supported flags

- `--project <dir>`: select the consumer root.
- `--adapter <id>`: repeatable adapter content-root selection for inspection.
- `--json`: render the structured result.
- `--help`: show command help.

`--dry-run`, selectors and writing/repair flags are not supported because the
command is read-only.

## Output

The structured result summarizes initialization state, project name, Core and lock
health, selected/detected/resolved adapters, generator state, pending proposals,
conflicts, verification profile status and derived `lifecycleState`.

Missing verification profile is reported as a warning/finding, not as implicit
authorization to verify anything.

## Writes

Nothing.

## Exit codes

- `0` for healthy initialized state with no findings.
- `1` for warnings such as a missing verification profile.
- `2` for invalid invocation.
- `3` for environment failures such as an inaccessible project path or
  unresolved Core root.
- `4` for missing/invalid required Paved state.
- `5` for adapter/capability resolution failures.
- `8` for pending generated conflicts.
- `9` for unexpected internal failures.
