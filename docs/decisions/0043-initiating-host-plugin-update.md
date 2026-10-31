# ADR 0043: Plugin update scoped to the initiating host

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Repository update adopts the runtime bundled in the selected plugin; it does not
refresh that plugin from its marketplace. Users requesting an update through an
agent expect both layers to be current, without changing other installed hosts.

## Decision

The update command projection guides the initiating agent to inspect its existing
Paved installation, refresh that marketplace and plugin, discover the newly installed
launcher, and invoke the repository update through it. Claude and Codex have
host-specific commands; the shared portable plugin limits Codex commands to Codex
and directs Cursor to its plugin manager.

Host refresh applies only to an explicit Paved update request. Dry-run skips host
writes, automatic repairs remain local, and missing plugins are not installed.
Keep existing scope and host permissions. Stop if the plugin is missing or on refresh or path discovery failure
before changing consumer state; report already completed host steps.

## Consequences

The agent update guide orchestrates host management; the direct CLI remains local
and deterministic. Consumer integrity, compatibility, lock and rollback semantics
are unchanged. Host updates are not part of the consumer transaction and may need
a session restart to load updated hooks and skills.

## Alternatives considered

- **Update every installed host:** changes unrelated installations against user intent.
- **Add host management to the Core CLI:** couples consumer update to host configuration
  and would introduce network side effects into existing local and dry-run operations.
- **Only document manual commands:** retains the two-step user experience instead of
  guiding the agent through the complete explicit update request.

## References

- [Command projections](../../integrations/shared/projection.ts)
- [Plugin generation](../../plugins/build.ts)
- [Installation and update guide](../getting-started/installing-the-plugin.md)
