# Agent integrations

Agent integrations are thin projections of Paved Core. They may package the
canonical `SKILL.md` documents and expose the existing `paved --json` CLI
contract, but they must not implement lifecycle, verification, generators,
adapters, provenance or arbitrary command execution.

Each adapter is project-local, deterministic and ownership-aware. The
consumer's `.paved/` state remains authoritative; generated agent files are
disposable Paved-owned projections and are never application source.
