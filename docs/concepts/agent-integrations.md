# Agent integrations

Agent integrations are thin, project-local projections of the stable
`paved/agent/v1` contract. Paved Core owns the canonical skills, workflows,
context, tools, lifecycle, diagnostics and verification; an integration only
packages those contracts in an agent-native layout.

## Supported integrations

| Integration | Generated layout | Capabilities |
|---|---|---|
| Codex | `.agents/skills/<skill>/SKILL.md` | context, skills, workflows, tools, verification, status, diagnostics, lifecycle |
| Claude Code | `.claude-plugin/plugin.json` and `skills/<skill>/SKILL.md` | same conceptual capabilities |

Install or remove a projection with the CLI:

```text
paved agent list --json
paved agent install codex --project /path/to/repository --json
paved agent update claude-code --project /path/to/repository --json
paved agent uninstall codex --project /path/to/repository --json
```

`agent status <integration>` and `agent validate <integration>` are read-only.
The generated files point back to `.paved/` and the JSON CLI contract; they do
not copy project state, execute arbitrary commands, or replace verification.

## Ownership and safety

Installations are project-local and Paved-owned. Repeated installation
converges to the same bytes. A manually edited or symlinked generated file is a
conflict and is never overwritten; uninstall removes only files still carrying
Paved's generated marker. Writes are staged atomically under the selected
project root while the existing operation lock prevents concurrent lifecycle
operations.

There is no global installation, marketplace registry, remote download path,
hook, MCP server, or unrestricted shell executor in this release. Future
integrations should implement a new adapter and reuse the shared projection and
contract tests rather than changing Core semantics.
