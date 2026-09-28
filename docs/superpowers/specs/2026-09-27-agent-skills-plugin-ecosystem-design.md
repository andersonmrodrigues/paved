# Phase 16 Agent Skills and Plugin Ecosystem

## Scope

Phase 16 adds a thin, agent-neutral integration package layer on top of the
existing `paved/agent/v1` CLI contract. Paved Core remains the canonical source
for skills, workflows, tools, context, lifecycle, diagnostics, ownership and
verification. Integrations only package canonical content for an agent and
translate invocation back to the existing CLI.

The first integrations are Codex and Claude Code. They use the current
Agent Skills format, with Codex repository projections under
`.agents/skills/` and Claude Code plugin projections under
`.claude-plugin/` and `skills/`. The generated projections contain thin
instructions and references to the project-local Paved contract; they do not
copy implementation logic or `.paved/` state.

## Architecture

```text
Paved Core canonical content
        |
        v
Agent integration package contract
        |
        +--> Codex projection (.agents/skills/)
        |
        +--> Claude Code projection (.claude-plugin/, skills/)
```

Integration metadata records the integration id and version, target agent,
supported Paved API/Core ranges, and generated-artifact ownership. A shared
projection engine selects canonical skills and emits deterministic files.
Agent-specific adapters supply only destination paths, metadata, and the
native invocation wording.

The CLI gains an `agent` command family for listing, installing, updating,
uninstalling, validating and reporting integration status. All writes use the
existing atomic-write, operation-lock, ownership and provenance helpers.
Installation is project-local, idempotent, reversible and refuses to overwrite
user-owned or manually modified files. It never edits application source or
the project-local `.paved/` source of truth.

## Public contract

The integration package contract is versioned independently from Core and
documents the same conceptual capabilities for both agents: context, skills,
workflows, tools, verification, status and diagnostics. The generated skill
instructions invoke `paved` through the documented JSON CLI boundary. They do
not embed shell blocks, duplicate lifecycle rules, or implement verification.

Compatibility failures are returned as the existing structured diagnostics and
exit categories. Unknown or incompatible Core/API metadata blocks installation.
The package metadata and generated files include provenance sufficient for
status, update and uninstall to distinguish Paved-owned artifacts from user
overrides.

## Context and safety

Generated instructions point agents to the documented `.paved/manifest.yaml`,
`.paved/project/`, rules, verification, tools, skills, workflows and overrides
paths. They do not dump all files into agent context. The project-local state
remains authoritative. No generic shell executor, remote registry, download
path, secret persistence, or unrestricted command capability is introduced.

Path resolution is restricted to the selected project root and generated
integration roots. Writes are staged and atomic; conflicts are reported without
partial installation.

## Testing

Tests cover the package schema and canonical projection semantics, Codex/Claude
cross-agent consistency, discovery/status/install/update/uninstall,
idempotency, ownership protection, compatibility failures, path safety and
failure recovery. A synthetic agent consumes only the public CLI and generated
files. The full `npm run check` remains the release gate.

## Known limits

Distribution through agent marketplaces is intentionally not implemented.
Global installation is not implemented until an agent's stable global
ownership and update semantics can be expressed without duplicating project
state. Existing contract-only `tool` and `evidence` command families remain
unavailable and are reported as such.
