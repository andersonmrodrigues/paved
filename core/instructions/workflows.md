# Running a workflow

Load this file when you start a workflow. `workflow.yaml` says what the run needs;
this file says how to carry it out, what to do when something fails, and what to record.

## Before the first phase

Check the standard preconditions, then the workflow's own `preconditions`:

1. The repository is available and you know the state of its working tree.
2. The repository's Paved installation is compatible (`lifecycle.md`, repository states).
3. Every `required` input is present. Restate each input in the run record with where it
   came from (`human`, `ticket`, `repository`). Never invent a missing input: the run
   stops as `input-missing` and you ask for it.
4. Every `required` context area of the workflow is readable.

A failed precondition stops the run before anything changes (`precondition-failed`).

## Phases

Run phases in the order `workflow.yaml` lists them, one at a time. A phase is done when
its goal is met and its gates hold. Skip a phase only when its `skip_when` condition
holds, and record how it holds; `verification`, `evidence` and `completion` are never
skipped.

- **Skills.** Activate the phase's skills in the listed order. A skill already active
  from an earlier phase continues where it was; it is never started twice. A skill whose
  "When to use" does not fit the task is recorded as not applicable, with the reason.
- **Tools.** Use only the phase's tools and those of its active skills. Discovery does not
  grant execution permission: resolve a compatible ToolImplementation, check permissions,
  environment, preconditions and approval first. A Tool's `safety` class holds unchanged
  inside a workflow.
- **Rules.** The run respects the workflow's `rules`, the rules of every active skill,
  and every rule whose `applies_to` matches the change, with the project's overrides
  applied. A workflow never changes a rule's severity.
- **Checks.** Each `required` check type must pass for completion. Record a missing
  check as a gap, but leave the task incomplete. `recommended` types run when the
  verification profile has them.

## Work documents

Keep durable Markdown work documents in the consumer repository under
`.paved/documents/`. Use the workflow run id in the filename so artifacts for one
change stay together. Create a document only when it helps explain or execute the
work; do not put machine state or local evidence here.

| Document | Path |
|---|---|
| Intent | `.paved/documents/intents/<run-id>.md` |
| Plan | `.paved/documents/plans/<run-id>.md` |
| Spec | `.paved/documents/specs/<run-id>.md` |
| Tasks | `.paved/documents/tasks/<run-id>.md` |
| Research | `.paved/documents/research/<run-id>.md` |

For `plan`, `feature`, `fix`, and `refactor`, write the plan at
`.paved/documents/plans/<run-id>.md`. Open that exact file with
`paved preview start .paved/documents/plans/<run-id>.md --run <run-id> --json`.
Resolve comments on that file before advancing for approval; approval is bound to its
exact digest. A resumed run must continue to use the plan path recorded in its existing
run events.

## Gates and approvals

A gate's `condition` must hold before the phase ends. A gate with `when` applies only
when that condition holds; otherwise record it as not applicable, with the reason.

A gate with `approval` needs a decision from a person: ask, show what is being approved
and the evidence so far, and wait (`awaiting-approval`). Record who decided and when. You
never approve your own run, and an approval covers only what was shown.

For a Markdown plan awaiting approval, use the canonical plan path above. Present the
preview URL and keep the agent turn active with `paved preview wait
.paved/documents/plans/<run-id>.md <revision> --json`. Comments reach you only while
`wait` runs, so call it again after every timeout and never end the turn while the plan
is open for review and not approved. Apply each selected-text comment
to that file and mark it resolved with `paved preview resolve
.paved/documents/plans/<run-id>.md <comment-id> --json`. After editing, advance the
workflow once to request approval for the revised plan hash. The preview's human
Approve button writes the approval record for the exact version shown; after it is
clicked, advance the workflow until the gate records the decision.

| Approval | Asked for |
|---|---|
| `destructive-operation` | Data loss or effects that cannot be undone |
| `production-change` | A change to a running shared or production system |
| `release` | Publishing to users |
| `security-exception`, `architecture-exception` | Accepting a deviation from a security or architecture rule |
| `breaking-change` | An incompatible change for consumers |
| `risk-acceptance` | Going ahead despite a known, unmitigated risk |

**Autonomy.** Read-only and safe-mutation work proceeds on your own judgement.
Destructive tools need their own confirmation and an approval gate in the phase that
uses them. High-impact work (every category above) needs an approval gate, whatever the
tools.

## Failures

When a phase cannot finish, record the failure: its code, the phase, what failed and
why, the evidence that shows it, whether a retry is safe, and the next action and who
takes it. Each code implies the run's status and its retry class:

| Code | Run | Retry |
|---|---|---|
| `input-missing`, `precondition-failed`, `context-missing` | blocked | requires-human |
| `tool-unavailable`, `rule-violation` | blocked | requires-human |
| `skill-unavailable` | blocked | non-retryable |
| `approval-required` | awaiting-approval | requires-human |
| `approval-rejected` | blocked | non-retryable |
| `skill-failed`, `verification-failed`, `inconclusive`, `evidence-insufficient` | failed | retryable |
| `retries-exhausted` | failed | requires-human |

**Retry.** Only `retryable` failures are retried, and only within the phase's `retry`
limit (two attempts unless the workflow says otherwise). Before a retry, change
something that addresses the recorded cause; repeating the same attempt is not a retry.
Keep the evidence of every attempt. When the limit is reached, the run fails as
`retries-exhausted` and a human decides. `non-retryable` means the plan must change;
`requires-human` means a person must act first.

## Completion

- **completed:** every phase completed or legitimately skipped, every gate passed or
  approved, every required check passed, required evidence present, no violated `error`
  rule, and the workflow's `completion.criteria` met. The evidence record is `complete`.
- **completed-with-warnings:** the same, with warnings reported: gaps, violated
  `warning` rules, recommended checks not run. The evidence record is `complete` and its
  gaps say why.
- **failed** or **blocked:** the evidence record is `incomplete` or `blocked`, and the
  run's failure says what happens next.

## The run record

A run may keep its state in `.paved/generated/runs/<id>.yaml` (kind `WorkflowRun`, see
`templates/workflow-run.yaml`): inputs, each phase's status, attempts, skills and gates,
the failure, warnings, outputs, the evidence path and an append-only list of events. It
is disposable: the evidence record is what persists. Update it as you go, never
afterwards from memory.
