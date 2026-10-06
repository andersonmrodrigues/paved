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

Claude Code and Codex also load plugin-bundled lifecycle hooks from
`shared/hooks.json`. Host hooks stay advisory and fail open. The prompt hook adds
session-scoped routing guidance; the Workbench hook sends minimal lifecycle activity
only to a running loopback dashboard. The dashboard and run inspection live in the
packaged CLI, not in either host projection.
