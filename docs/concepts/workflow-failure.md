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

## Testing Tools scoped to the change

During a workflow run, the testing Tools run only where the change is, as Checks honor
`applies_to`. A testing Tool runs when one of the files the run changed is under its
binding's `invocation.working_directory`, or matches the binding's `applies_to` globs when
the ToolImplementation declares them. A binding at the repository root always runs. Local
build dependencies widen the set: a Maven module that consumes a running module runs too,
and so does every module a running one needs installed. The other Tools are recorded as
`skipped` with the reason (in the test result's `outcomes` and in the `validation`
`tool-invoked` event as `skipped=<id> (<reason>)`), reported as
`PAVED_WORKFLOW_TESTS_SCOPED`, and do not decide the outcome.

Scoping needs changed files. The baseline at plan approval and a refactor's baseline run
every Tool, as does validation of a run with no changed file. Standalone `paved test`
always runs every Tool.

## Timeouts

A testing Tool runs under its contract's `timeout_seconds`, lowered by its binding's
`invocation.timeout_seconds` and by an approved override; a binding cannot exceed its
contract. A Tool that reaches its limit is reported as `timed-out` with
`PAVED_TEST_TOOL_TIMED_OUT` and the limit in seconds, apart from `PAVED_TEST_TOOL_FAILED`.
In a workflow both count as a test failure. To give one module longer, raise the limit on
that module's Tool and binding (`.paved/tools/` and `.paved/tool-implementations/`).

## Environment failures and the baseline

A failed test run is not always a regression. When the testing Tool's output shows a
service that refused the connection or did not resolve, a missing container engine, or a
missing program (exit code 126 or 127), the test runner records the Tool result with
`error_code: environment-failure` and reports `PAVED_TEST_ENVIRONMENT_UNAVAILABLE`.
Validation, and bug discovery, then block with `PAVED_WORKFLOW_ENVIRONMENT_UNAVAILABLE`
instead of failing: no attempt is spent, and the run continues once the environment is
available or those tests are excluded from the testing Tool. The classification only
changes how a failure is reported; it never lets a run pass.

When the plan is approved and nothing has changed yet, Paved runs every testing Tool once
and records the outcome as the run's baseline (a `tool-invoked` event in `planning` with
`baseline status=passed|failed|environment-unavailable`, followed by `; failing=<ids>`,
`; timed_out=<ids>` and `; unavailable=<ids>` for the Tools of a suite). A baseline that did not pass is reported
with the approval itself as a `PAVED_WORKFLOW_BASELINE_FAILING` finding naming each Tool,
its working directory and its evidence, so the user decides before implementation whether
to fix those tests in this change, exclude them, or make their environment available.
Approval is not blocked: in a test-first change the tests are expected to fail.

If validation later fails and the baseline had failed too, the failure carries
`PAVED_WORKFLOW_BASELINE_FAILING` again. For a suite it separates the Tools that passed at
approval and fail now, which the change likely broke, from the Tools that were already
failing.

When every Tool that fails now already failed (or timed out) at approval, nothing points
at the change, so validation asks the user instead of failing: a required run decision
(`run.pre-existing-failures`) that cites the baseline evidence and offers two options,
with no recommendation.

- `accept`: validation passes for this run with a `PAVED_WORKFLOW_BASELINE_ACCEPTED`
  warning. The decision records who answered (`--answered-by`), the validation event
  records `accepted pre-existing failures=<ids>` with the baseline evidence as its ref,
  and the workflow evidence record lists the failures as a gap with `accepted_by`.
- `fix`: validation fails as before until the tests pass.

Paved never answers this decision itself. A Tool that passed at approval and fails now is
a fresh failure: validation fails without asking, whatever was accepted earlier.

Limits: each testing Tool reports one exit code and text output, so the baseline compares
Tools, not individual tests, and a failure the user chose to fix still spends an attempt.
Comparing failing tests one by one (for example from JUnit reports), applying the same
baseline to verification checks, and having onboarding detect tests that need external
infrastructure and propose excluding or tagging them are follow-up work.

The bug workflow's guidance adds a domain-specific stop: two failed fix attempts mean the
cause was not confirmed, so discovery is repeated rather than a third fix attempted.
