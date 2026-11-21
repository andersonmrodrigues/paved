---
name: paved
description: Use when a request needs lean Paved task routing; activate only the matching playbook.
---
# Paved
## When to use
Route a repository task.
## Required context
Relevant project rules.
## Preconditions
Honor installed workflows and host permissions.
## Procedure
State the goal and smallest change; state an assumption for non-product ambiguity.
Activate one skill:
- `setup`: initialization or maintenance.
- `feature`: behavior changes.
- `bug`: defect diagnosis and repair.
- `refactor`: structure without behavior changes.
- `investigate`: read-only questions.
- `verify`: proof and coverage gaps.
- `review`: independent inspection.
- `ship`: authorized delivery.
- `reflect`: durable lessons.
- `task`: handoff and mid-flow scope.
- `design`: user-facing design or experiments.
## Tools
Use available host capabilities.
## Rules
Never bypass active gates.
## Verification
Check outcomes, not promises.
## Evidence
Label proof and uncertainty.
## Completion criteria
A matching playbook is active.
## Failure modes
Conflicting rules: escalate.
## References
[Details](references/playbook.md).
