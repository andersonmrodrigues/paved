# ADR 0045: Authorized automatic plugin updates

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

ADR 0043 makes explicit plugin updates host-scoped, but relying on model guidance
does not provide a deterministic 24-hour update during use. A host-level refresh
is shared across projects; runtime adoption and active workflow state are not.
The portable plugin also serves Cursor, which must never invoke Codex management.

## Decision

Add a standalone plugin-layer checker and launcher `auto-update configure`,
`status` and `check` interface. Defaults are disabled. Only explicit `configure`
persists project authorization (`off`, `notify`, `auto`, interval and host).
Strict configuration/state schemas prohibit arbitrary executable paths/commands.

Trusted session-start and prompt-submit hooks invoke the checker directly.
Generated host context identifies Claude; the portable hook additionally checks
Codex's injected `PLUGIN_ROOT` against its physical Codex cache location. Missing
positive identification fails closed. Cursor has no supported update lifecycle
hook/management API; it remains a manual plugin-manager operation.

Host refresh is serialized and throttled per host home/plugin id/scope/project
installation identity. It refreshes only `paved`, only an already installed
`paved@paved`, preserving scope. Project adoption has an independent timestamp and
uses the refreshed authoritative launcher, including when another project already
refreshed the host. No launcher paths are read from repository-writable preferences.

Automatic adoption holds the existing consumer operation lock across runtime
selection and the Core update. Its direct child may borrow that lock using a
random token checked against its parent PID and owner record, only for `update`.
The Core still performs a local transaction; no host management enters the Core
CLI. Workflow inspection happens while holding that lock; any resumable/unknown
run defers migration. Existing bootstrap integrity, compatibility and rollback
checks apply. Busy deferrals do not record project success or failure backoff.
Workflow entrypoints also hold this lock across their full mutation, with explicit
async-local reuse by nested local phases. This closes the existing start/write race;
ordinary lock acquisition remains exclusive outside that workflow scope.

CI and dry-run suppress checks and writes. Host subprocesses have bounded
timeouts, failures have exponential backoff, and existing locks are never deleted
based solely on elapsed time. Notify only checks installed inventory and writes
metadata; upstream freshness remains unknown without a supported read-only query.

## Consequences

The authorization is a reviewed local preference, not an application's approval
to implement a workflow. Existing routing reminders remain available, including
when updates fail. Due checks can delay a prompt; otherwise checks are local and
cheap. No background service runs. Current-session hooks/skills are not swapped:
results report restart requirements. Host refresh is not rolled back when project
adoption fails; prior project pins and transaction recovery stay authoritative.

The Claude plugin was already at its 512-file limit. Plugin runtime packing omits
duplicate integration TypeScript sources when their compiled JavaScript twins are
present; standalone launchers, hooks, schemas and runtime assets remain shipped.
Both hosts continue to pin the same normalized runtime integrity.

## Alternatives considered

- **Prompt the model every day:** not deterministic, especially across long sessions.
- **One timestamp for host and project:** starves later projects of adoption.
- **Update every installed host:** violates the initiating host's authorization.
- **Infer Codex from portable packaging or CODEX_HOME:** can execute Codex in Cursor.
- **Delete expired locks:** risks concurrent updates after slow or suspended processes.
- **Move host commands into Core CLI:** breaks its local/offline/dry-run boundary.

## References

- [ADR 0043](0043-initiating-host-plugin-update.md)
- [Launcher checker](../../integrations/shared/auto-update.mjs)
- [Consumer operation lock](../../cli/lib/operation-lock.ts)
- [Installation guide](../getting-started/installing-the-plugin.md)
- [Codex hook environment source](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs)
- [Codex inventory source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/plugin_cmd.rs)
