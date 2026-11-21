---
name: bug
description: Use when reproducing, diagnosing and fixing a reported defect.
---
# Bug
## When to use
An observed defect.
## Required context
Symptom and affected path.
## Preconditions
Distinguish facts from guesses.
## Procedure
Reproduce, test a causal hypothesis, add a failing regression, then fix the cause.
Activate `bug-investigation` for deeper diagnosis.
## Tools
Safe observations and tests.
## Rules
Avoid speculative edits.
## Verification
Rerun the regression and affected checks.
## Evidence
Before-and-after results.
## Completion criteria
The symptom is proved fixed.
## Failure modes
No reproduction: label the gap.
## References
[Diagnostic options](references/playbook.md).
