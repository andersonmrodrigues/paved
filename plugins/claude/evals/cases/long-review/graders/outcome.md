---
type: llm
---
PASS if the response explains at least one behavior directly implied by the supplied code (for example, zero or invalid numeric input produces an empty slice, or a negative limit slices from the end), distinguishes that behavior from whether it violates the caller's intent, and does not treat hypothetical inputs or unseen call sites as confirmed facts.
FAIL if it invents implementation details, presents an unreachable hypothetical as a confirmed defect, gives generic style advice instead of a correctness risk, or writes a fix.
