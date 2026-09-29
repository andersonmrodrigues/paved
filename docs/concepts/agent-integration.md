# Agent Integration Contract

**Contract version:** `paved/agent/v1`  
**Status:** stable for the local CLI surface. Codex and Claude Code projections
include a project-local launcher that verifies and installs a pinned package
under `.paved/runtime/`.

This document defines the boundary between an external AI agent and Paved Core.
An integration may translate an agent's conventions into these operations, but
Paved Core must not contain branches for Codex, Claude Code, Cursor, OpenCode,
or any other agent.

## Discovery

An integration discovers Paved without inspecting implementation directories:

1. `paved --version` reports the installed Core version.
2. `.paved/manifest.yaml` identifies a consumer and declares its compatible Core
   range and selected adapters.
3. `.paved/paved.lock`, when present, records exact resolved versions and
   digests.
4. `paved status --project <root> --json` reports initialization, resolution,
   lifecycle, adapter and verification availability.

The packaged CLI may be selected explicitly with the documented `--project`
option. A missing manifest is an uninitialized consumer, not an invitation to
infer project configuration.

## Public operations

The CLI is the public transport. Every implemented command supports the common
structured result rendered by `--json`:

```json
{
  "command": "status",
  "status": "success",
  "data": {},
  "diagnostics": []
}
```

`data` is command-specific. `diagnostics` is always an array. Integrations must
not parse human output when JSON is available.

| Capability | Public operation | Availability |
|---|---|---|
| Discovery | `paved --version`, manifest and lock | Always, subject to installation |
| Command discovery | `paved agent commands --json` | Always when the local Core CLI is available; each command reports its own lifecycle/capability availability |
| Command contract resolution | `paved agent command <name> --json` | When the command exists; unavailable commands include a reason and recommended next action |
| Context | `status --json`, documented `.paved/project/` context paths | After initialization/generation |
| Skills | resolved Core/project skill content and existing skill contracts | When the consumer is resolved |
| Workflows | resolved Core/project workflow content and existing workflow contracts | When the consumer is resolved |
| Tools | Tool contracts and declared implementations | Contract and resolution surface; `paved tool` is not executable |
| Verification | `verify --json` | When a valid verification profile and bindings exist |
| Status | `status --json` | Always; reports `UNINITIALIZED` when needed |
| Diagnostics | `doctor --json` and result diagnostics | Whenever a command can assess state |
| Gardener | `gardener --json` | Read-only and only when consumer evidence is available |

## Context and content loading

The authoritative consumer contract is `consumer_layout` in `manifest.yaml`.
Context is under `.paved/project/`; project rules, verification, tools, skills
and workflows are under their corresponding `.paved/` paths. Generated
disposable state is under `.paved/generated/` and is not an integration source
of truth.

Agents consume document identity, schema, ownership and provenance, not the
generator that produced a document. Freshness comes from lifecycle state and
lock/generator evidence, not timestamps alone. An integration must preserve the
distinction between available, stale, missing, unknown and incompatible state.

## Lifecycle and status

`status` and `doctor` expose the derived lifecycle state. The currently
implemented states are:

`UNINITIALIZED`, `RESOLVED`, `GENERATED`, `VALIDATED`, `READY`, `STALE`,
`INCOMPATIBLE`, and `BROKEN`.

The state is authoritative for readiness. A `.paved/` directory by itself does
not mean that a consumer is ready. Updates and regeneration remain Paved
operations; an integration must not edit lock, generated state, or application
source directly.

## Skills, workflows, tools and verification

Skills and workflows retain their existing schemas and versioned identities.
Tools remain capability contracts with separately resolved implementations.
Verification remains the single completion gate: an agent invokes `verify`,
examines checks, evidence, diagnostics and remediation, and corrects work before
finishing. No agent-specific verification mechanism is introduced.

`paved evidence` and `paved tool ...` are documented contract-only command
families in this release. An integration must report them unavailable rather
than pretending they are executable.

## Diagnostics, errors and compatibility

Each diagnostic contains `severity`, `category`, `code`, `component`, `message`,
and optional `remediation`. Categories map deterministically to exit codes:

| Category | Exit code |
|---|---:|
| `success` | 0 |
| `findings` | 1 |
| `usage` | 2 |
| `environment` | 3 |
| `config` | 4 |
| `resolution` | 5 |
| `generation/update` | 6 |
| `verification` | 7 |
| `conflict` | 8 |
| `internal` | 9 |

The highest-precedence category is the primary result category, while all
diagnostics are retained. Integrations should branch on category/code and
present the message/remediation; they must not infer error type from prose.

Compatibility is the tuple of Core version, supported document API version
(`paved/v1`), adapter versions/digests, and this contract version. A compatible
Core does not imply that every consumer capability is currently available.
Unknown compatibility and required migrations block updates.

## Public versus internal

Public: the CLI commands and JSON result shape, manifest/lock and consumer
document schemas, documented consumer layout, lifecycle states, diagnostics,
exit-code mapping, and version/compatibility semantics.

Internal: TypeScript modules and classes, generator execution and traversal,
adapter implementation details, persistence and transaction helpers, temporary
staging directories, and disposable generated state. Integrations must not
import or depend on them.

## Security boundary

Paved does not grant an integration capabilities beyond the declared Tool and
verification contracts. Integrations must not persist secrets, send repository
data remotely, execute arbitrary commands, bypass ownership or lifecycle checks,
apply Gardener proposals automatically, or modify application source as a
side effect of normal integration operations.

## Canonical interaction

1. Discover version and consumer manifest.
2. Inspect `status --json`.
3. Load relevant context and resolved content.
4. Invoke the applicable command and inspect top-level `decisions[]` and `diagnostics[]`.
5. Present emitted questions and relay only the user's explicit answer through the same command.
6. Keep blockers separate from optional decisions; an answer never overrides a diagnostic.
7. Perform the agent's work, run Paved verification, and consume remediation.
8. Correct and verify again until the contract permits completion.

Command contracts declare `interaction`, `decisionSources` and `answerChannels` in
`paved agent commands --json`. Codex and Claude Code render the same short resume guidance
and reference the [canonical decision skill](../../core/skills/decisions/decisions/SKILL.md)
for presentation, batching and authorship rules. See [conversational decisions](decisions.md)
for the record and CLI contract.

Agent-specific projections must keep project-local `.paved/` state authoritative
and must not silently upgrade Core, consumer state, or adapters.

## Agent-first command contract

The shared command catalog is stable under identifiers `paved.<name>` and
contains development commands (`plan`, `implement`, `test`, `verify`, `review`,
`debug`, `refactor`, `feature`, `fix`) and management commands (`init`, `status`,
`update`, `doctor`, `gardener`). Each entry reports input/output contracts,
required context, allowed side effects, lifecycle states, workflow/Tool
mapping, and failure semantics. The agent may present commands as Codex skills
or Claude slash commands, but the semantics and `.paved/` source of truth are
shared.

Each command also declares whether its interaction is `conversational` or
`read-only`, whether decisions come from `runtime` or `agent`, and which answer
channels (`relayed` or `human-authored`) it can require. Both host projections
render the same short answer-and-resume contract for conversational commands and
point to `core.decisions.decisions` for the complete protocol.

The catalog is descriptive and agent-neutral. Development tasks remain
orchestrated by the coding agent through the existing Paved workflows, Skills,
Tools, context and verification engine. `paved agent command` resolves the
contract and checks current availability; it does not execute a prompt or
arbitrary command. The CLI `paved test` operation does execute an explicitly
declared testing Tool through a compatible ToolImplementation; command
discovery reports it available only when that binding resolves. Testing
evidence remains incomplete and unverified until the separate Paved verification
command runs.

**Bootstrap limitation:** integrations project command files from an available
runtime, but do not yet distribute or install the Core runtime. The `paved-core`
package has a constrained pack layout and its local artifact is checked for
SHA-512 integrity metadata; no public artifact or independent agent bootstrap
is configured. A clean consumer without an accessible runtime cannot complete
`/paved:init` through the generated command alone. The integration reports this
limitation rather than fetching or executing remote code. A clean offline
tarball-install smoke test validates the packed CLI, including initialization,
command discovery, status and an explicitly bound test Tool, but it does not
provide a published package or agent-managed bootstrap.
