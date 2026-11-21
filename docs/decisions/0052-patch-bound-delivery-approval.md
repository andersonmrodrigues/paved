# ADR 0052: Patch-bound approval at the delivery boundary

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

[ADR 0050](0050-governed-change-delivery.md) tied delivery readiness to a stable patch
fingerprint and required a human to confirm each merge. The GitHub adapter still invoked
`gh pr merge` directly, however, so no durable record connected that confirmation to the
target, change request, head revision and exact verified patch. Plan approval or an
approval for a moved head must never authorize a later merge.

## Decision

1. A `DeliveryApproval` records a person's identity and timestamp together with the exact
   target, change request, head revision and verified patch fingerprint. Its deterministic
   path is derived from all four action fields.
2. `paved delivery approve` requires the user to confirm those exact values. It checks
   `paved status --base <target>`, the current local `HEAD`, and the repository host's
   target and head before writing the record. It does not merge.
3. `paved delivery merge` repeats the freshness, local `HEAD` and repository-host checks,
   validates the matching approval, then asks GitHub to squash-merge with
   `--match-head-commit`. It never uses a shell or retries a failed merge.
4. `core.change-request.merge` requires the target as well as the change and head. The
   GitHub adapter routes through `paved delivery merge`; required remote checks remain a
   precondition read through `core.change-request.status`, and GitHub branch protection
   remains authoritative. The adapter's host confirmation is still required: a Paved
   approval record grants no host permission.
5. The v2-to-v3 readiness marker is created only after the delivery and independent-review
   gates pass their contract tests and migration tests prove human-owned state remains
   unchanged.

## Consequences

- Approval for one target, change request, head or patch cannot authorize another.
- A rebase that preserves the patch still needs a fresh action approval because the
  approved head revision changed; the verified patch evidence itself may remain fresh.
- The skill and adapter-mediated path use the Paved boundary. Direct host commands outside
  that path remain governed by repository permissions and branch protection, not by Paved.
- Merge status and check vocabulary remain host-owned; Paved does not poll or reinterpret
  remote checks.

## Alternatives considered

- **Keep a direct `gh pr merge` binding.** Rejected: the adapter could not verify the local
  patch-bound approval at the action boundary.
- **Reuse workflow-plan approval.** Rejected: plan approval does not name a change request,
  head or patch and can outlive implementation changes.
- **Let Paved infer that the user approved from a green status.** Rejected: readiness and
  checks are observations, not authorization for an irreversible shared action.

## References

- [ADR 0050](0050-governed-change-delivery.md)
- [Change delivery skill](../../core/skills/code-review/change-delivery/SKILL.md)
- `schemas/delivery-approval.schema.yaml`
