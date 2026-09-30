# ADR 0032: Update adopts a newer plugin runtime

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** [0026](0026-native-plugin-distribution.md)

## Context

ADR 0026 made the lock authoritative and left runtime changes to an explicit
`runtime upgrade`. In practice `paved update`, the command users run after updating the
plugin, executed the old pinned runtime, which compared the project against its own Core
and reported nothing to do. The only hint was a notice on standard error. `runtime
upgrade` was exposed by no skill, so updated plugins left projects on the old runtime.

The upgrade also refused to run while a rollback record from an earlier upgrade existed.
That check is reached only after the active selection has been validated against the
lock, so the state is always consistent there and the record is a stale backup: every
second consecutive upgrade was blocked.

## Decision

- When the plugin carries a runtime newer than the one pinned by `paved.lock`, or the
  lock pins none, the launcher runs `update` through the same transactional path as
  `runtime upgrade`: verify and activate the plugin runtime, let it move the lock through
  the Core's update, restore the previous selection and leave the lock untouched on
  failure, and keep the previous lock and selection for `runtime rollback`.
- `update --dry-run` reports the runtime that would be adopted and changes nothing.
- A plugin carrying the same or an older runtime never changes the pin; `update` runs the
  pinned runtime as before, and an older plugin never downgrades the project.
- A new upgrade replaces a leftover rollback record once the selection matches the lock.
  An interrupted upgrade still fails selection validation and points to `runtime
  rollback`.
- A project without runtime state (a fresh clone, since `.paved/runtime/` is ignored)
  upgrades like a legacy lock: rollback restores the lock and the pinned runtime is
  reacquired on demand.
- `runtime status`, `runtime upgrade` and `runtime rollback` remain available.

## Consequences

- Updating the plugin and running `paved update` is enough to move a project to the new
  runtime; the lock change is reviewed in version control like any other update.
- Other commands still never switch runtime: only `update` and `runtime upgrade` do.
- Rollback covers the most recent upgrade only.

## Alternatives considered

- **Keep the explicit upgrade and add a skill for it.** Rejected: users run `update` after
  a plugin update and expect it to update; a second command repeats the same failure.
- **Adopt on any command.** Rejected: a status or verification call must not change a
  committed lock as a side effect.
- **Allow downgrades.** Rejected: an outdated plugin on one machine would move the whole
  team's lock backwards.

## References

- [0026](0026-native-plugin-distribution.md), [0022](0022-consumer-lifecycle-and-atomic-local-update.md)
- `integrations/shared/bootstrap.mjs`
