---
name: feature
description: Use when adding or changing behavior with a clear observable outcome.
---
# Feature
## When to use
Requested behavior changes.
## Required context
Affected code and rules.
## Preconditions
Keep active approvals.
## Procedure
Define claims; choose a sibling pattern. For known behavior, run a failing test,
then implement the smallest complete fix. Activate `feature-development` for details.
## Tools
Project checks and diff.
## Rules
Preserve trust boundaries.
## Verification
Run focused tests; inspect side effects.
## Evidence
Commands, results and gaps.
## Completion criteria
Claims have proof or explicit limits.
## Failure modes
Unresolved product choice: escalate.
## References
[Implementation detail](references/playbook.md).
