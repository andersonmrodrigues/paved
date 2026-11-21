---
name: verify
description: Use when proving a change and identifying missing verification.
---
# Verify
## When to use
Before making a success claim.
## Required context
Declared checks and diff.
## Preconditions
Know which claims need proof.
## Procedure
Run `paved verify --changed`; inspect coverage and side effects. After two distinct
fix attempts still fail, escalate. Load relevant testing references only.
## Tools
Installed verification runner.
## Rules
No invented hook guarantees.
## Verification
Exercise real user paths where relevant.
## Evidence
VERIFIED: proof; NOT VERIFIED: gaps; INFERRED: reasoning.
## Completion criteria
Results and limits are explicit.
## Failure modes
Missing environment: report, never fabricate.
## References
[Testing levels](references/playbook.md).
