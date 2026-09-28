# ADR 0024: Agent integration projections

## Status

Accepted

## Decision

Agent integrations are project-local projections of canonical Paved skills. A
shared renderer supplies semantics and safety; each adapter supplies only its
agent-native destination and metadata. The CLI remains orchestration and the
`.paved/` tree remains the source of truth.

Codex uses `.agents/skills/`; Claude Code uses a `.claude-plugin/plugin.json`
and `skills/`. Generated files are Paved-owned, marked, deterministic and
protected from overwriting after manual edits.

## Consequences

The same skill and capability contract is exposed to both agents without
duplicated verification or lifecycle engines. Marketplace, remote and global
installation are deferred. New agents can be added without adding agent names
or filesystem conventions to Core.
