# Migrating to Paved 2.0

Paved Core 2.0.0 replaces the 1.x development commands with three steps over one run:
`intent`, `plan` and `execute`. It removes the `performance`, `incident` and `release`
workflows. The reasons are in [ADR 0036](../decisions/0036-intent-plan-execute.md).

## Commands

| 1.x agent command | 2.0 |
|---|---|
| `feature`, `fix`, `refactor` | `intent "<request>"`: Paved classifies the request as `feature`, `bug` or `refactor`, or asks you |
| `plan` (alias of `feature`) | `intent`, then `plan` (the new step: write the plan, review it, approve it) |
| `debug` | `intent` with the failure report; the `bug` workflow reproduces and confirms the cause |
| `implement`, `review` | `execute` |
| `test`, `verify` | Run inside `intent` and `execute`; still available as `paved test` and `paved verify` CLI subcommands |
| `doctor` | `status`, which shows the same diagnostics and repair decisions; still available as the `paved doctor` CLI subcommand |
| `gardener` | Listed by `execute` when a run completes; adopt proposals with the `paved gardener` CLI subcommand |
| `init`, `status`, `preview`, `update` | Unchanged |

## Steps

1. **Allow Core 2 in the manifest.** In `.paved/manifest.yaml`, change `paved.core` from
   the 1.x range that `init` wrote (for example `^1.16.1`) to `^2.0.0`. `update` refuses a
   Core outside that range with `PAVED_MANIFEST_CORE_INCOMPATIBLE` and changes nothing, so
   this is the one manual edit the upgrade needs.
2. **Plugin consumers:** update the Paved plugin in your agent (see
   [Installing the plugin](installing-the-plugin.md#update-the-plugin)), then run `paved update`
   in the repository so it adopts the 2.0 runtime
   ([Upgrade or roll back a repository's runtime](installing-the-plugin.md#upgrade-or-roll-back-a-repositorys-runtime)).
   The 2.0 plugin no longer contains the removed commands.
3. **Project-local projection** (`.agents/skills/` or `.claude/`): run `paved update`, then
   `paved agent update codex` or `paved agent update claude-code`.
4. Run `paved status` and act on what it reports. Commit `.paved/manifest.yaml` and
   `.paved/paved.lock` once you have reviewed the change.

## What happens automatically

- `paved update` rewrites the managed Paved block in `AGENTS.md` so it names the new
  commands. Text outside the block is never changed. Until then, `paved status` reports
  the block as outdated (`PAVED_AGENTS_BLOCK_OUTDATED`).
- `paved agent update` deletes the Paved-generated files of removed commands. A file
  without the Paved header is yours and is never touched.
- Runs started with 1.x resume: `paved status` lists open runs, and the step that owns a
  run's current phase continues it (`intent` for `context` and `discovery`, `plan` for
  `planning`, `execute` from `implementation` on).

## What you must do

- **Overrides on removed workflows.** An override in `.paved/overrides/overrides.yaml`
  that targets `core.performance`, `core.incident` or `core.release` fails with
  `PAVED_OVERRIDE_TARGET_MISSING`: `paved status` reports it and `paved update` stops
  until it is fixed. Remove the override, or retarget it to `core.feature`, `core.bug` or
  `core.refactor` if what it said still applies there.
- **Performance work.** Run it as a `refactor` when behavior must not change, or as a
  `feature` when it sets a new budget. The performance skills, the
  `core.performance.measure-before-optimizing` rule and the `performance` check type are
  unchanged.
- **Scripts and CI** that call `paved feature`, `paved fix`, `paved refactor`,
  `paved implement`, `paved review` or `paved debug` must move to `paved intent`,
  `paved plan` and `paved execute`. `paved test`, `paved verify`, `paved doctor` and
  `paved gardener` are unchanged.
