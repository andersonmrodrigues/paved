# 0010. Machine-readable dependency model

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Architectural boundaries described only in prose erode. The Core needs its own
components to follow the dependency rules it asks consumers to follow.

## Decision

- `components` in the Core manifest declares each top-level directory, whether it is
  distributed, and what it may depend on.
- A test enforces: all directories declared, no cycles, distributed depends only on
  distributed, Markdown links and TypeScript imports only along declared edges, no
  project or adapter ids in Core content.

## Consequences

- Boundary violations fail the test suite.
- A new top-level directory requires a deliberate manifest change.
- References in YAML and prose mentions are not checked.

## Alternatives considered

- **Nx-style project graph with tags.** Inspired this, but a tool dependency is not
  justified for seven components.
- **Documentation only.** Rejected by principle 3.

## References

- [Nx enforce module boundaries](https://nx.dev/features/enforce-module-boundaries)
- [boundaries](../concepts/boundaries.md)
