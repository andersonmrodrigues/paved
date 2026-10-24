# 0039. Host-native task delegation and model policy

**Status:** Accepted
**Date:** 2026-10-23

## Context

Paved users execute workflows through coding-agent hosts such as Claude Code and
Codex. Independent implementation tasks can benefit from parallel sessions, and simple
tasks can use lower-capacity models while difficult work uses stronger reasoning. The
Core must remain host-neutral and must not own provider credentials, prompts, API calls
or session scheduling. Host capabilities and model catalogs vary and can change.

## Decision

Represent optional implementation delegation as a schema-validated `DelegationPlan`
bound to the hash of the human-approved workflow plan. Each task declares dependencies,
bounded repository read/write paths, an output contract and a relative model capacity
and reasoning-effort policy. The CLI validates acyclic dependencies, non-overlapping
unordered write scopes, task readiness and concurrency. A human approves the immutable
delegation graph digest before any task starts. Shared-workspace writers are serialized;
Paved snapshots Git-status file digests at start and checks the observed changed paths
against exact write scopes at completion.
For isolated worktrees those paths are host-reported and the primary agent inspects the
integrated diff. Interrupted attempts require explicit recovery after confirming that
the native session stopped. The workflow cannot advance
until every registered task is recorded complete.

The active Claude Code or Codex agent creates and supervises work using the host's
native agent/session tools. Paved does not call model APIs or create sessions. Agents
inspect the host's actual model choices, map relative policy to available choices, and
record the actual host, model and effort. A host that cannot select a different model
for each worker keeps its native inheritance behavior; policy remains guidance and
actual selection is recorded. Optional usage is host-reported and explicitly
unverified.

Do not persist prompts, credentials or raw session identifiers. If a host session id is
useful for correlation, persist only its SHA-256 digest. Delegated output is untrusted
until the primary agent inspects the resulting diff and reports; existing validation,
review, verification and approval gates remain authoritative. A graph modified after
registration fails integrity validation. An approved plan amendment supersedes the
graph and requires a new one if delegation is still useful.

## Consequences

- A new `DelegationPlan` document and CLI commands make the graph and task lifecycle
  machine-readable and auditable.
- Paved can enforce graph consistency and resource boundaries without claiming that
  the host executed a particular model or that usage figures are exact.
- Model identifiers remain host-reported strings rather than a brittle Core catalog.
- Concurrency is bounded within the graph; host-level capacity and permissions remain
  controlled by Claude Code or Codex.
- Delegation is optional. Small or dependent work can stay in the primary session.

## Alternatives considered

- Direct provider API orchestration was rejected because Paved runs inside agent hosts
  and must not own provider credentials or duplicate host execution tools.
- A hard-coded model catalog was rejected because availability and naming vary across
  hosts and versions.
- Unbounded free-form subagent prompts were rejected because they provide no durable
  dependency, write-scope or provenance contract.

## References

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [OpenAI Agents SDK multi-agent systems](https://developers.openai.com/api/docs/guides/agents-api/multi-agent)
