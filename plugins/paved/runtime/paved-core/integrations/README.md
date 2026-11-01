# Agent integrations

Agent integrations are thin projections of Paved Core. They package canonical
`SKILL.md` documents and agent-native command prompts from one shared semantic
catalog, and invoke the existing `paved --json` CLI dispatcher. They must not
implement lifecycle, verification, generators, adapters, provenance or
arbitrary command execution.

The Codex projection installs canonical skills and `$paved-<command>` command
skills under `.agents/skills/`. The Claude Code projection installs canonical
skills and `/paved:<command>` project commands under `.claude/commands/paved/`.
Both use the same command contract. `paved agent commands --json` discovers
lifecycle-aware availability; `paved agent command <name> --json` resolves one
contract. The existing `paved agent list`, `status`, `validate`, `install`,
`update` and `uninstall` operations remain supported.

Each projection includes `bootstrap.mjs` and a version-pinned `bootstrap.json`.
The launcher reads `.paved/paved.lock` when present, verifies the selected
tarball and installed content, and invokes the packaged CLI under
`.paved/runtime/`. It refuses mismatched or corrupt state. The consumer's
`.paved/` state remains authoritative; generated agent files are disposable
Paved-owned projections and are never application source. `paved agent install`
can project both integrations from a packed artifact.

The installable plugin in `plugins/` reuses this layer: its skills are rendered by
`shared/projection.ts` from the same catalog, and its `scripts/paved.mjs` is
`shared/bootstrap.mjs` unchanged. Consumers normally install that plugin through
native plugin installation instead of committing a project-local projection.

For parallel implementation work, Paved Core provides a bounded delegation graph and
task/model policy, while execution remains host-native. Claude Code agents/sessions and
Codex collaboration/session tools are selected and started by the active host agent;
Paved neither calls provider APIs nor assumes a fixed model catalog. The runtime records
the actual host-reported model, effort and optional usage. If a host does not expose
per-task model selection, the agent follows that host's available routing behavior and
records what actually ran.

Claude Code and Codex also load plugin-bundled lifecycle hooks from
`shared/hooks.json`. Host hooks stay advisory and fail open. The prompt hook adds
session-scoped routing guidance; the Workbench hook sends minimal lifecycle activity
only to a running loopback dashboard. The dashboard and run inspection live in the
packaged CLI, not in either host projection.

Explicit project authorization can enable `shared/auto-update.mjs` through the
plugin launcher `auto-update configure|status|check`. Trusted session/prompt hooks
then run due checks deterministically, preserving routing reminders. Host commands
are hardcoded and host/scope-specific; project adoption delegates to the existing
transactional local runtime. Defaults are off, Cursor is manual, and CI/dry-run
never refresh hosts. Authorization and throttle contracts have schemas; templates
are `shared/auto-update-config.template.yaml` and `shared/auto-update-state.template.yaml`.
