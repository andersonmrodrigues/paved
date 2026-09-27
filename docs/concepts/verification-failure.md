# Verification failure

Keep the failed result, observations, output reference, revision, environment and tool
version. A failure is debugging input; do not remove it when the task is retried. `failed`
means the expectation was violated. `error` means no verdict could be produced.
`blocked` means an applicable check did not start because a precondition was unmet.
`skipped` means it did not apply; `inconclusive` means it ran without a reliable verdict.

The check definition sets `retry.class` and at most three attempts. Retryable errors may
be rerun; environment-dependent retries need a changed environment; non-retryable checks
have one attempt. Each attempt is recorded. A failure followed by a pass is flaky and
remains `inconclusive`, never a clean pass. Repeated identical failures should stop
automatic retries and become a Gardener or human investigation signal.

The completion assessor blocks on failed or errored checks, unmet required types,
unsupported claims, violated error rules and unmet criteria. Warning rules and missing
recommended checks are reported without blocking. A `blocked` task status is reserved
for a record whose only blocking problems are required checks that could not run. See
[evidence](evidence.md) for status meanings.
