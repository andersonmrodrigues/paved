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

The installable plugin may also project shared lifecycle hooks that route each user
prompt toward applicable Paved commands. Hooks are host-native integration packaging,
remain advisory, and may not invoke Core commands or change consumer files. Their
trust and fallback contract is recorded in [ADR 0031](0031-prompt-aware-plugin-hooks.md).

## Consequences

The same skill and capability contract is exposed to both agents without
duplicated verification or lifecycle engines. Prompt routing improves discovery when
users make plain-language requests, while the Paved runtime remains authoritative for
availability and gates. Marketplace, remote and global installation are deferred. New
agents can be added without adding agent names or filesystem conventions to Core.
