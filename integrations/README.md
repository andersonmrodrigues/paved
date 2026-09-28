# Agent integrations

Agent integrations are thin projections of Paved Core. They may package the
canonical `SKILL.md` documents and expose the existing `paved --json` CLI
contract, but they must not implement lifecycle, verification, generators,
adapters, provenance or arbitrary command execution.

The current Codex projection installs canonical skills under `.agents/skills/`;
the Claude Code projection installs its plugin descriptor and skills in the
project-local layout. `paved agent list`, `status`, `validate`, `install`,
`update` and `uninstall` expose their lifecycle. These projections do not install
the Core CLI or copy Core instructions into the consumer.

Each projection is deterministic and ownership-aware. The consumer's `.paved/`
state remains authoritative; generated agent files are disposable Paved-owned
projections and are never application source. The repository's agent contract and
onboarding guide describe the local-checkout prerequisite.
