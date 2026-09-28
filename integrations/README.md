# Agent integrations

Agent integrations are thin projections of Paved Core. They package canonical
`SKILL.md` documents and agent-native command prompts from one shared semantic
catalog, and expose the existing `paved --json` CLI contract. They must not
implement lifecycle, verification, generators, adapters, provenance or
arbitrary command execution.

The Codex projection installs canonical skills and `$paved-<command>` command
skills under `.agents/skills/`. The Claude Code projection installs canonical
skills and `/paved:<command>` project commands under `.claude/commands/paved/`.
Both use the same command contract. `paved agent commands --json` discovers
lifecycle-aware availability; `paved agent command <name> --json` resolves one
contract. The existing `paved agent list`, `status`, `validate`, `install`,
`update` and `uninstall` operations remain supported.

Each projection is deterministic and ownership-aware. The consumer's `.paved/`
state remains authoritative; generated agent files are disposable Paved-owned
projections and are never application source. The repository's agent contract and
onboarding guide describe the local-checkout prerequisite. Projections do not
install the Core runtime: current use requires an accessible local Core checkout,
and no remote or global bootstrap is provided.
