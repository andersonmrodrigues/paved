# Repository lifecycle

The local CLI manages one consumer repository at a time. Its repository root and
`.paved/manifest.yaml` identify the consumer for the current operation. The human-owned
`project.name` is a display name, not a global identifier; moving or cloning a
repository does not change its Paved identity. No absolute path or Git remote is
written into the lock.

## Initialization

`paved init` discovers the selected repository root, refuses any existing `.paved/`
state, detects supported technologies, resolves local adapters, writes the Project
manifest and exact lock, then generates context unless `--no-generate` is set.
`--dry-run` uses a temporary copy and leaves the consumer unchanged. Init does not
configure a verification profile automatically and does not claim that generated
context has been reviewed.

## States

`paved status --json` and `paved doctor --json` expose `data.lifecycleState`:

| State | Repository evidence |
|---|---|
| `UNINITIALIZED` | No Project manifest. A stray `.paved/` does not count as initialized. |
| `INITIALIZED` | Valid manifest, but the lock is missing or invalid. |
| `RESOLVED` | Valid manifest and matching lock; no generated context. |
| `GENERATED` | Generated context exists; an explicit valid verification profile is absent. |
| `VALIDATED` | Profile exists, but conflicts, pending proposals or other blocking findings prevent readiness. |
| `READY` | Matching lock, generated context, valid profile and no outstanding diagnostic preventing readiness. |
| `STALE` | Locked Core, adapter, generator or capability content, generator inputs (contract, engine, manifest) changed, or a recorded generated output is missing. |
| `INCOMPATIBLE` | Manifest range or locked versions cannot use the available Core/adapters. |
| `BROKEN` | Manifest, Core metadata or generated metadata is invalid. |

Source drift is not `STALE`. When files that generated context cites change, or new
relevant source files appear (`PAVED_GENERATED_SOURCE_STALE`,
`PAVED_GENERATOR_SOURCE_SET_STALE`), the repository keeps its state and `status` reports
`generatedContext: drifted` with warnings. Ordinary development causes this drift, so it
must not block `test`, `intent`, `plan` or `execute`. `status` offers a repair decision to
regenerate the context; `execute "<request>"` regenerates it before starting, and a run
regenerates it again when it completes. Integrity problems above stay `STALE` and block
work until `paved update` resolves them.

Diagnostics and exit categories remain separate from lifecycle state. A stale
consumer may also have a conflict, and a missing profile can be reported alongside
other findings. The state is computed from files and digests; timestamps do not
decide it.

### Linked Git worktrees

Paved separates two roots. The **state root** is the checkout whose `.paved/` holds the
Paved state in use. The **source root** is the checkout whose files are read, tested and
digested. In a normal checkout both are the project root, and nothing below applies.

In a linked Git worktree without its own `.paved/manifest.yaml`, Paved reads the `.git`
file and the worktree's `commondir` to find the main worktree. When the main worktree has
`.paved/manifest.yaml`, it becomes the state root and the linked worktree stays the source
root. `status` then reports `stateRoot` and `sourceRoot`, and the info diagnostic
`PAVED_WORKTREE_STATE_IN_MAIN` says shared state is in use; it changes neither the status
nor the exit code.

A worktree with its own `.paved/manifest.yaml`, committed or not, always uses it. Because
`init` in a linked worktree sees the shared state, a worktree gets its own state by
checking out a branch that commits `.paved/`. Only a consumer at the repository root is
shared: a nested consumer in a linked worktree needs its own `.paved/`.

| Path or operation | Root |
| --- | --- |
| Manifest, lock, approvals, decisions, documents, rules, verification profile, Tools | state |
| Generated context, proposals, `last-run.json`, evidence, reviews, delegation graphs and results | state |
| Workflow runs and intent documents | state |
| `.paved/runtime/` (pinned runtime, `bin/paved`) and the consumer operation lock | state |
| The managed `AGENTS.md` block and agent projections | state |
| Testing and verification Tool working directory, revision and Maven module planning | source |
| Generator source scanning, adapter and capability detection, check and rule detection | source |
| Provenance digests, run fingerprints, the evidence diff and delegation workspace snapshots | source |
| `--file` for `delegation plan` | `.paved/...` in state, anything else in source |
| `--evidence`, `--result` and `preview` targets | state |

Tools run in the source root, so a project Tool implementation whose command names a
script under `.paved/` by a relative path does not find it from a linked worktree; keep
such scripts in the repository, or make the binding independent of the working directory.

Every path the CLI resolves goes through `resolveSafePath` against the root it belongs
to, so it cannot escape that root or traverse a symbolic link in either. The consumer
operation lock lives in the state root, so commands from different worktrees that write
shared state run one at a time.

Generated context describes one checkout. Each generator execution in `last-run.json`
records `sourceWorktree` when it read a linked worktree, and `status` lists them as
`contextWorktrees`. Drift is judged against the checkout the context came from, whichever
worktree runs `status`: the recorded worktree when it is still a checkout of the state
root, otherwise the state root. Changes in another worktree are therefore not drift.
`update`, a repair and `execute` regenerate from the current source root, which moves the
context there. A completing run refreshes context only when the context already came
from its own worktree.

A workflow run records `worktree` when it started in a linked worktree. A run continues
only from the checkout it records: `--run` from any other refuses with
`PAVED_WORKFLOW_WORKTREE_MISMATCH`, the automatic selection lists only the current
worktree's open runs, and the same request started in another worktree gets its own run.

The stable command `.paved/runtime/bin/paved` lives in the state root and works from a
linked worktree too: it passes the caller's directory to the launcher, which keeps a
linked worktree of that project as the source root. Remediation texts therefore print
the main worktree's command.

## Local update

`paved update` loads the existing valid lock, checks the manifest range and local
adapters, validates project documents and override targets, and computes affected
generators from their declared dependencies and recorded inputs. A Core move beyond
a known compatible patch line is reported as unknown compatibility and blocked.
Documents that fail the candidate schema stay unchanged unless exactly one known
deterministic migration applies. `paved update` runs that migration on the staged
copy and validates it before publishing; any other case blocks the update
([versioning](versioning.md#evolving-a-schema)). Override targets that disappeared
or changed digest require review.

For an applicable update, Paved copies the consumer into a temporary workspace,
generates affected context there, validates the staged state, checks that the real
consumer has not changed during staging, and swaps its `.paved/` directory. The
previous directory is held at `.paved.update-backup` during the swap. A failure
before commit leaves the old `.paved/` authoritative. A failed second rename
restores it. If a process stops during the swap, the backup is recoverable and a
subsequent update refuses to proceed while it exists. Human-owned files are copied
into the stage and never rewritten by generators; conflicts produce disposable
proposals. Application source files are read only.

`--dry-run` plans generation without publishing state. The Core and adapters must
already be available locally. Remote resolution, fleet-wide rollouts, and Core
caches are planned rather than implemented. An unknown schema change is not
rewritten by guessing; only a reviewed migration from the typed registry runs.

Generated context records source hashes and generator metadata. `status` detects
changed or removed cited files, newly relevant source files, changed manifest and
generator inputs, and changed locked Core or adapter content. A source-only change
is drift rather than staleness and can be reconciled by `update` without rewriting an
unchanged lock. Context review
and an explicit verification profile remain human decisions.
