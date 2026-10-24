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
| `STALE` | Content digests, generator inputs or relevant source evidence changed. |
| `INCOMPATIBLE` | Manifest range or locked versions cannot use the available Core/adapters. |
| `BROKEN` | Manifest, Core metadata or generated metadata is invalid. |

Diagnostics and exit categories remain separate from lifecycle state. A stale
consumer may also have a conflict, and a missing profile can be reported alongside
other findings. The state is computed from files and digests; timestamps do not
decide it.

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
can be reconciled by `update` without rewriting an unchanged lock. Context review
and an explicit verification profile remain human decisions.
