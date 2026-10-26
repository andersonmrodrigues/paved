# 0041. Shared state across linked worktrees

- Status: accepted
- Date: 2026-10-26

## Context

Users change code in linked `git worktree`s so the main checkout stays untouched. The
`.paved/` directory is usually untracked, so it exists only in the main worktree. Version
2.16.0 detected that state from a linked worktree but did not use it, because reading it
from the main worktree would also have tested and digested the main checkout instead of
the one being changed.

## Decision

The CLI resolves two roots. The state root holds `.paved/`; the source root is the
checkout whose files are read, tested and digested. A linked worktree without its own
`.paved/manifest.yaml` uses the main worktree as its state root when the main worktree has
one; otherwise both roots are the project root. `projectRoot` keeps meaning the state
root, and only source-dependent code receives the source root.

Generated context records the linked worktree it was generated from, and drift is judged
against that checkout. A workflow run records its linked worktree and resumes only there.
The launcher and the stable command resolve the same roots, keeping the runtime and lock
in the state root.

## Consequences

Normal checkouts are unchanged. Worktrees share one set of decisions, approvals, runs and
generated context, serialized by the operation lock in the state root. Generated context
describes one checkout at a time: regenerating it from another worktree moves it there.
A project Tool binding that runs a `.paved/` script by a relative path must not depend on
the working directory. Nested consumers in linked worktrees and preview of documents
outside `.paved/` from a linked worktree are not shared.

## Alternatives considered

- Requiring `.paved/` to be committed was rejected: it is the user's choice, and state
  such as runs and evidence would then fork per branch.
- Treating the main worktree as the project (`--project <main>`) was rejected because
  tests and digests would describe the wrong checkout.
- Per-worktree digests for every generator in one context were rejected: generated
  documents describe a single source tree, so recording which one is sound and simpler.

## References

- [Repository lifecycle](../concepts/repository-lifecycle.md#linked-git-worktrees)
