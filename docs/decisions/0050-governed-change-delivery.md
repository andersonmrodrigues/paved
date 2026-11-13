# ADR 0050: Governed change delivery and patch-identity evidence

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

A Paved run ends once its change is verified, recorded as evidence and independently
reviewed. What happens next (opening a change request, reading automated checks and
review comments, merging) was outside the evidence chain, and the obvious way to tie
them together does not work: evidence is bound to a revision, and a rebase moves the
same change to new commit ids. Treating the new head as unverified forces pointless
re-runs; treating any head on the branch as verified lets a later edit ship under an old
verdict. Opening a change request also mutates a shared system, and merging cannot be
undone in place.

## Decision

1. **A verdict covers a patch.** Workflow evidence records `change.patch_id`, the stable
   patch fingerprint of the run's change (committed, uncommitted and untracked files,
   excluding Paved state) against `change.patch_base`. Both fields are optional, so the
   schema change is additive. The CLI computes it with the source-control tool it
   already uses for revisions and working-tree digests. A pure function,
   `patchFreshness`, decides whether recorded evidence still describes a head: only an
   identical fingerprint is fresh; a missing one never is.
2. **Delivery readiness is a read-only report.** `paved status --base <target>` computes
   the head's fingerprint against its merge base with the target and reports
   `data.delivery` for the latest completed run in the checkout: `fresh`, `uncommitted`
   and `ready`. It contacts no remote.
3. **Change requests are Core capabilities without a service.** `core.change-request.open`
   is `high-impact` (confirmation per invocation), `.status` is `read-only`, and `.merge`
   is `destructive` and requires the head revision it must still be at. The
   `infrastructure/github` adapter binds them to the GitHub CLI; merges are squashed and
   pinned with `--match-head-commit`, so the merged commit carries the verified patch and
   a head that moved after the freshness check is refused.
4. **Delivery follows the run; it is not a phase.** The `change-delivery` skill guides it,
   and the feature, bug and refactor workflows point to it after completion. A merge
   needs its own human confirmation naming the change request, head and target; plan
   approval never covers it.

No new phase, gate or approval is added and none is relaxed. The workflow versions get a
patch bump for the guidance.

## Consequences

- A rebase without conflicts keeps evidence fresh; a fix for a review comment, or a
  rebase that resolved conflicts into a different patch, requires a new run.
- The fingerprint is computed against the run's starting revision. A run started on a
  branch that already carried other commits records only its own change, so a change
  request that also carries those commits reports `patch-changed`. This errs toward
  re-verification.
- The patch fingerprint is not a Core Tool. Computing it needs a diff piped into a second
  command, and a ToolImplementation is a single argv with no standard input, so no
  binding could express it without a shell. It sits beside the revision and digest
  capture the CLI already performs.
- Detection of `infrastructure/github` relies on GitHub Actions workflow content, since a
  repository's remote is not readable from its files. Repositories hosted on GitHub
  without Actions workflows select the adapter explicitly.
- Required checks passing is a precondition the agent reads through the status Tool;
  Paved does not poll the remote or interpret a service's check vocabulary.

## Alternatives considered

- **A `delivery` phase in each workflow.** It would extend the shared `phase` enum, which
  consumers write and Paved branches on (breaking for readers), and keep runs open across
  CI and review latency measured in hours or days.
- **A workflow fragment.** Fragment Tools become required phase Tools, so every run would
  need a change-request binding; and a phase that can reach the destructive merge needs a
  `destructive-operation` gate, which would be a new gate with no honest handler inside a
  run that ends before the change request exists.
- **A separate delivery workflow.** It needs a change type and intent classification, and
  workflows do not compose, so it could only reach the run's evidence by file anyway.
- **Revision-bound freshness.** Simple, but every rebase would discard valid evidence.

## References

- [ADR 0016](0016-verification-check-and-completion.md), [ADR 0018](0018-tool-safety-and-evidence.md),
  [ADR 0019](0019-source-control-boundary.md), [ADR 0046](0046-bounded-workflow-fragment-composition.md)
- GitHub CLI manual: `gh pr create`, `gh pr view`, `gh pr merge`
