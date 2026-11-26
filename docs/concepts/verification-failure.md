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

## Pre-existing failures

When a base revision is known (`paved verify --changed --base <ref>`, which the Stop
hook passes with the branch the change was cut from: its upstream, its reflog's
"Created from" entry or the default branch, whichever is closest), a failed check is compared with the same check
on the merge base. The base outcome comes from an earlier record for that base and the
same check definition, or the failed checks alone are run once more, each within its
timeout, in a temporary detached worktree of the base that is always removed. The
evidence keeps both outcomes: the head result and its `baseline` with its own output
reference.

The failure is `pre_existing` when the base also failed with the same exit code and
every failure line of the head output also appears in the base output. A failure line
is one containing a word such as fail, error, exception, panic or fatal. Lines are
compared after removing ANSI colors, replacing the checkout path with `<root>`,
masking timestamps and durations and collapsing whitespace; nothing else is masked, so
a new test name, count or location is a new line. A head output with no failure line
never counts as pre-existing.

The base worktree holds only committed files, so a check needing ignored files there
(installed dependencies, a local `.env`) fails or is blocked differently on the base;
the comparison then leaves the failure as a failure. Pre-existing failures and
environment-blocked checks make the result `warning` rather than `failed`: they are
reported, never shown as passed.
