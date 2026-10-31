# Workflow failure and retry

A workflow run fails explicitly, toward the stricter behavior
([failure handling](failure-handling.md)). A failure is data: it has a code, a phase, a
reason, the evidence that shows it, a retry class and a next action.

## Failure codes

One table, in `cli/lib/workflows.ts` (`FAILURE_CODES`), fixes the run status and retry
class each code implies; the schema enum, `core/instructions/workflows.md` and these docs
follow it, and tests keep them in sync.

| Code | Means | Run status | Retry |
|---|---|---|---|
| `input-missing` | A required input was not provided | blocked | requires-human |
| `precondition-failed` | A standard or workflow precondition does not hold | blocked | requires-human |
| `context-missing` | Required context cannot be found or inferred safely | blocked | requires-human |
| `tool-unavailable` | A required tool is absent, denied or unreachable | blocked | requires-human |
| `skill-unavailable` | A required skill is missing or disabled | blocked | non-retryable |
| `rule-violation` | The correct change violates an `error` rule | blocked | requires-human |
| `approval-required` | A gate waits for a human decision | awaiting-approval | requires-human |
| `approval-rejected` | A human rejected an approval | blocked | non-retryable |
| `skill-failed` | A skill could not reach its completion criteria | failed | retryable |
| `verification-failed` | A required check failed or errored | failed | retryable |
| `inconclusive` | A check ran but could not decide | failed | retryable |
| `evidence-insufficient` | A claim or requirement lacks support | failed | retryable |
| `retries-exhausted` | A retryable failure reached the phase's limit | failed | requires-human |

The spec's vocabulary maps onto this table: *blocked* and *failed* are run statuses,
*approval_required* is `approval-required`, and the others keep their names in kebab
case. `input-missing`, `skill-unavailable`, `approval-rejected` and `retries-exhausted`
were added because they need different next actions.

## Recording a failure

The failure is recorded on the phase and, when it stops the run, on the run. Its
`reason` says what failed and why in terms a human can act on; `evidence` lists the ids
of the checks and artifacts that show it; `next_action` says what must happen and who
does it. `assessRun` checks that the retry class matches the code, that the run status
matches the code, and that the failure names a phase that actually failed or is stuck.

## Retry

| Class | Meaning | Who retries |
|---|---|---|
| `retryable` | Another attempt may succeed once the cause is addressed | The agent, within `max_attempts` (default 2, at most 5) |
| `non-retryable` | The plan must change; repeating it cannot succeed | Nobody; the plan changes |
| `requires-human` | A person must act first (provide, grant, decide) | The agent, after the human acts |

- The failure code's class wins over the phase's: an `approval-rejected` failure is never
  retried, whatever the phase allows.
- A retry must change something that addresses the recorded cause. Repeating the same
  attempt is a loop, not a retry.
- Evidence of every attempt is kept; a retry appends, it never replaces.
- When the limit is reached the failure becomes `retries-exhausted` and a human decides.
- A phase that can reach a destructive tool must not be `retryable`
  (`assessWorkflowQuality`).

## Environment failures and the baseline

A failed test run is not always a regression. When the testing Tool's output shows a
service that refused the connection or did not resolve, a missing container engine, or a
missing program (exit code 126 or 127), the test runner records the Tool result with
`error_code: environment-failure` and reports `PAVED_TEST_ENVIRONMENT_UNAVAILABLE`.
Validation, and bug discovery, then block with `PAVED_WORKFLOW_ENVIRONMENT_UNAVAILABLE`
instead of failing: no attempt is spent, and the run continues once the environment is
available or those tests are excluded from the testing Tool. The classification only
changes how a failure is reported; it never lets a run pass.

When the plan is approved and nothing has changed yet, Paved runs the testing Tool once
and records the outcome as the run's baseline (a `tool-invoked` event in `planning` with
`baseline status=passed|failed|environment-unavailable`, followed by `; failing=<ids>` and
`; unavailable=<ids>` for the Tools of a suite). A baseline that did not pass is reported
with the approval itself as a `PAVED_WORKFLOW_BASELINE_FAILING` finding naming each Tool,
its working directory and its evidence, so the user decides before implementation whether
to fix those tests in this change, exclude them, or make their environment available.
Approval is not blocked: in a test-first change the tests are expected to fail.

If validation later fails and the baseline had failed too, the failure carries
`PAVED_WORKFLOW_BASELINE_FAILING` again. For a suite it separates the Tools that passed at
approval and fail now, which the change likely broke, from the Tools that were already
failing. Validation still requires every Tool to pass.

Limits: each testing Tool reports one exit code and text output, so the baseline compares
Tools, not individual tests, and a failure on a failing baseline still spends an attempt.
Comparing failing tests one by one (for example from JUnit reports), applying the same
baseline to verification checks, and having onboarding detect tests that need external
infrastructure and propose excluding or tagging them are follow-up work.

The bug workflow's guidance adds a domain-specific stop: two failed fix attempts mean the
cause was not confirmed, so discovery is repeated rather than a third fix attempted.
