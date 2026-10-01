# `paved doctor`

Diagnose invalid or inconsistent Paved state and return actionable findings. It is
read-only; it does not repair files or run verification checks.

## Inputs

- The selected project root.
- `.paved/manifest.yaml`, `.paved/paved.lock`, generated provenance, generator
  state, pending proposals/conflicts and verification profile state.
- Local Core schemas, manifest, adapters and capability registry.

## Supported flags

- `--project <dir>`: select the consumer root.
- `--adapter <id>`: repeatable adapter content-root selection for inspection.
- `--json`: render the structured result.
- `--help`: show command help.

`--run-checks`, `--dry-run`, selectors and repair flags are not supported.

## Checks

`doctor` reports diagnostics for uninitialized consumers, invalid manifest/lock
documents, Core version/digest mismatch, unavailable or undetected adapters,
adapter digest drift, ambiguous capabilities, missing verification profile,
pending proposals, generator conflicts, tampered generated provenance and missing
required consumer-layout paths.

Diagnostics include stable codes, severity, category, component and remediation
when available. Document contents and secret values are not printed.

## Writes

Nothing.

## Exit codes

- `0` for healthy initialized state with no findings.
- `1` for warnings/non-blocking findings.
- `2` for invalid invocation.
- `3` for environment failures such as an inaccessible project path or
  unresolved Core root.
- `4` for invalid or missing required configuration/state.
- `5` for adapter/capability resolution failures.
- `8` for pending generated conflicts where applicable.
- `9` for unexpected internal failures.
