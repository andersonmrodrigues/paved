# Verify

Use to prove claims. Run the smallest relevant checks and record commands and outcomes;
check the real user path and side effects when applicable. `paved verify --changed`
selects checks for the diff; inspect its output and do not assume all behavior was
covered. After two distinct fix attempts still fail, escalate with evidence.
Report VERIFIED only with evidence, NOT VERIFIED for gaps, and INFERRED for reasoning
not yet confirmed. Hooks and evidence recording depend on the installed host and CLI;
do not claim a block or automatic record without observing it.

Details: [unit](../testing/unit-testing/SKILL.md),
[integration](../testing/integration-testing/SKILL.md),
[e2e](../testing/e2e-testing/SKILL.md),
[regression](../testing/regression-testing/SKILL.md), and
[app verification](../testing/app-verification/SKILL.md).
