# ADR 0022: Consumer lifecycle and atomic local update

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

One local Core checkout can serve many consumers. Local locks record exact inputs, but
updates must expose a complete lifecycle state and make changes transactional: generation
could write context before the new lock was committed. A failed update could leave
the consumer's generated context and lock describing different inputs.

## Decision

The consumer's repository root and Project manifest define its operational identity.
`project.name` is human-owned display metadata, not a globally unique identifier.
Each consumer owns its own manifest, lock, context, overrides and disposable state.
No consumer state is stored in the Core checkout.

The lock is the authority for exact local Core, adapter and generator inputs. It
records versions, source labels and content digests. The resolution timestamp is
metadata; it is never an input to compatibility, impact or staleness decisions.
`status` derives lifecycle state from the manifest, lock, generated evidence,
verification profile and diagnostics. It does not persist a mutable state flag.

`update` separates planning, staging, validation and commit. It stages a copy of
the consumer, validates generated output and human-owned contracts, then swaps the
`.paved/` directory with a recoverable backup. Only a successful stage advances the
lock. A change to the real consumer during staging aborts the commit. Override
target changes and unknown compatibility require review rather than automatic
retargeting or migration. Context regeneration follows generator dependencies and
recorded source evidence.

## Consequences

Independent repositories can use the same Core without sharing mutable state.
Updating one consumer cannot advance another consumer's lock or rewrite its context.
The temporary copy costs disk space proportional to the non-ignored consumer files.
A process interruption between filesystem renames may leave
`.paved.update-backup`; this is deliberately visible and recoverable.

## Alternatives considered

- Write generated files in place and the lock last: rejected because failed
  generation can leave context ahead of the authoritative lock.
- A global consumer registry: rejected because it would make identity depend on
  machine or service state and weaken repository portability.
- Automatically edit overrides and project-owned documents: rejected because
  similarity of names or schemas is not evidence of human intent.

## References

- `docs/concepts/repository-lifecycle.md`
- `docs/concepts/multi-repository.md`
- `cli/lib/consumer-state.ts`
- `cli/lib/update-transaction.ts`
