---
name: refactor
description: Use when restructuring code while preserving its existing behavior.
---
# Refactor
## When to use
Structural improvement only.
## Required context
Callers and current behavior.
## Preconditions
Keep behavior changes separate.
## Procedure
Pin behavior with characterization tests, change one boundary at a time,
and activate `refactoring` for detailed safeguards.
## Tools
Focused checks and diff.
## Rules
Preserve public contracts.
## Verification
Check callers and observable effects.
## Evidence
Characterization results.
## Completion criteria
Structure changed without observed drift.
## Failure modes
Behavior differs: investigate before proceeding.
## References
[Refactor guidance](references/playbook.md).
