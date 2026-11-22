# ADR 0053: Adaptive lanes and honest verification

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Core v3 made direct work the default and kept `intent`, `plan` and `execute` for explicit
requests. A governed run, however, always walks every phase and always needs an approved
plan, so for small fixes the cheapest honest option was to leave Paved entirely. In a
real session this happened repeatedly, including during a production incident.

The same session showed the Stop hook reporting `NOT VERIFIED` for reasons that were not
the change's fault:

- a worktree without the git-ignored `.env`, so integration tests could not start;
- a test that already failed on the base branch;
- a Stop-hook verify colliding with the agent's own run on the operation lock;
- a stale sibling module installed from another branch;
- a generic message that did not say which check failed, which forced a full manual rerun.

## Decision

### Adaptive lanes

1. Classifying a request also picks a **lane**: `trivial`, `standard` or `risky`, with the
   same `--because` evidence rule as the workflow. A run without a lane is `standard`,
   which keeps today's behavior.
2. Phases declare `skip_in_lanes`. A phase skipped by the lane is recorded as `skipped`
   with the lane and its evidence, so the gap stays reviewable. Every workflow keeps
   implementation, verification, evidence and completion in every lane; planning and its
   plan approval are skipped in `trivial` and `standard`, and required in `risky`.
3. Phases may declare `routing_by_lane` to lower or raise capacity and effort per lane:
   `trivial` work runs at the economy tier, `risky` review at the frontier tier.
4. Each command is a valid entry point. `intent` stops after classification, `plan
   "<request>"` classifies and stops at the plan, and `execute "<request>"` classifies and
   runs the lane's phases. A run can be **escalated** (`--lane risky --because`), which
   reopens planning and requires its approval before completion.
5. Deterministic guards keep the agent's judgment honest. At completion Paved compares the
   run's diff with `flow.protected_paths` from the project overrides and with
   `flow.max_trivial_files`. A run whose diff touches a protected path, or a `trivial` run
   that grew past the limit, cannot complete until it is escalated and its plan approved.
6. The managed project instructions route change requests through `paved execute`; Paved
   picks the lane. Questions still do not start runs, and explicit user direction wins.

### Honest verification

7. A check may declare `environment.requires` (files and environment variable names). When
   one is missing the check is `blocked` with `PAVED_CHECK_ENVIRONMENT_UNAVAILABLE`, naming
   what is missing and never reading values. Paved never loads or copies secrets.
8. When a check fails and a base revision is known, Paved runs that check on the base in a
   temporary detached worktree, or reuses evidence for the same base tree. If the base
   fails too and the head shows no failure line the base lacks, the failure is
   `pre_existing`. Evidence records both outcomes and output references.
9. A check may declare `depends_on`. The runner orders checks by dependency and blocks
   dependents of a failed or blocked dependency instead of running them on stale inputs.
10. Verify's overall status is `warning`, not `failed`, when every remaining problem is
    pre-existing or environment-blocked; the result lists them.
11. The Stop hook verifies the branch's changes against the merge base with the default
    branch when it can find one. When the lock is held it waits within its budget and
    reuses the evidence of the run that held it. Its message names each failing or blocked
    check, its status, its output reference and a short failure excerpt; a pass with
    warnings surfaces them as a one-line note instead of blocking.

## Consequences

- Small fixes stay inside Paved at a cost close to direct work: one call to start, one to
  complete, verification and evidence still recorded.
- The agent's lane choice is advisory only until the diff confirms it; protected paths and
  size limits make a wrong `trivial` call fail closed.
- A `warning` verify is not a pass: the hook and the result say what was not proven.
- Schema changes are additive (optional fields and an optional overrides section), so the
  release is a minor version.
