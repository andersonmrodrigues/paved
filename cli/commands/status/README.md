# `paved status`

Report the repository's Paved state without changing anything.

## Output

- Repository state (not initialized, context missing, context stale, incompatible,
  ready), as defined in `core/instructions/lifecycle.md`.
- Core and adapter versions: declared range, locked version, newest available.
- Stale generated documents and the sources that changed.
- Unreviewed generated documents and open unknowns, by area.
- Pending proposals and unresolved conflicts.

## Options

`--json`.
