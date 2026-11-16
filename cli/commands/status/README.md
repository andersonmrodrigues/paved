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
- `--base <ref>`: also report `delivery` for the latest completed run in this checkout:
  its evidence's `patch_id`, the patch HEAD proposes against the merge base with `<ref>`,
  whether the two match (`fresh`), whether uncommitted changes exist, and `ready`. A
  mismatch, a missing fingerprint or uncommitted changes add `PAVED_DELIVERY_NOT_READY`.
- `--help`: show command help.

`--dry-run`, selectors and writing/repair flags are not supported because the
command is read-only.

## Output

The structured result summarizes initialization state, project name, Core and lock
health, selected/detected/resolved adapters, generator state, pending proposals,
conflicts, verification profile status and derived `lifecycleState`.
`generatedContext` is `drifted` when generated project context cites source files that
changed since it was generated, or new relevant source files appeared; `staleGenerators`
then names the generators concerned. The drift is reported as one
`PAVED_GENERATED_CONTEXT_STALE` warning that does not block work. The repair decision,
`paved update --json`, or `paved generate <generator>... --json` regenerates the context,
and an open run regenerates it when it completes.

Missing verification profile is reported as a warning/finding, not as implicit
authorization to verify anything.

When the plugin launcher started the runtime, it passes the Core version it carries in
`PAVED_LAUNCHER_CORE_VERSION`. If that version is newer than the Core pinned by
`.paved/paved.lock`, status adds the warning `PAVED_CORE_UPDATE_AVAILABLE` with the
remediation `paved update`, and `data.coreUpdate` holds `pinnedVersion`,
`availableVersion` and a one-line `summary`. When nothing more urgent applies (no
waiting decisions, repairs, verification setup or open run), `nextAction` asks to run
`paved update --json` before starting work. Status never updates anything itself. The
direct CLI passes no launcher version and reports nothing; projects pinned to a runtime
older than this check only show the launcher's `PAVED_RUNTIME_UPDATE_AVAILABLE` notice
on standard error until they update once.

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
