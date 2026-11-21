---
name: ship
description: Use when the user requests delivery of a verified change.
---
# Ship
## When to use
Requested delivery only.
## Required context
Diff and review results.
## Preconditions
Irreversible actions need human approval unless already explicitly authorized.
## Procedure
Check proof and scope before commit, push, PR or deployment.
Activate `change-delivery` for detailed delivery safeguards.
## Tools
Authorized delivery tools.
## Rules
Respect explicit no-delivery requests.
## Verification
Confirm actual delivery state.
## Evidence
Results, identifiers and limits.
## Completion criteria
Only authorized actions occurred.
## Failure modes
Missing proof: report the blocker.
## References
[Delivery boundaries](references/playbook.md).
