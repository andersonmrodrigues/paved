# Running a workflow

Load this file when you start a workflow. `workflow.yaml` says what the run needs;
this file says how to carry it out, what to do when something fails, and what to record.

## Steps

A run goes through three steps over one run id. Each step owns a fixed range of phases;
a step invoked outside its range returns `PAVED_WORKFLOW_STEP_OUT_OF_RANGE` and names the
step that owns the current phase.

| Step | Phases |
|---|---|
| `paved intent "<request>"` | classification, `context`, `discovery` |
| `paved plan` | `planning` |
| `paved execute` | `implementation` through `completion` |

Pass the user's request to `intent` verbatim. Add `--workflow <feature|bug|refactor>
--because "<evidence>"` only when the evidence shows the kind of change; otherwise omit it
(optionally `--recommend <id> --because "<evidence>"`) and present the returned decision.
A request that mixes kinds of change is passed with one `--part` per part and becomes a
split decision. `plan` and `execute` act on the only open run, or on `--run <id>`; with
several open runs they ask which one. A bug's failing regression test and a refactor's
passing baseline run inside `intent`; tests and verification run inside `execute`. When a
step returns their decisions, present them and repeat the same call with the answers.

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

`intent` writes the Intent document. In the `plan` step, write the plan at
`.paved/documents/plans/<run-id>.md`. The plan starts from the run's Intent document and
links to it, so the reviewer sees the request and classification the plan answers. Open
that exact file with
`paved preview start .paved/documents/plans/<run-id>.md --json`, or a folder with
`paved preview start <folder> --json` when several documents are reviewed together
(a plan with its specs, an epic with its tasks). A resumed run must continue to use the
plan path recorded in its existing run events.

## Gates and approvals

A gate's `condition` must hold before the phase ends. A gate with `when` applies only
when that condition holds; otherwise record it as not applicable, with the reason.

A gate with `approval` needs a decision from a person: ask, show what is being approved
and the evidence so far, and wait (`awaiting-approval`). Record who decided and when. You
never approve your own run, and an approval covers only what was shown.

For a Markdown plan awaiting approval, use the canonical plan path above. Present the
preview URL and keep the agent turn active with `paved preview wait <target> <revision>
--json`. Comments reach you only while `wait` runs, so call it again after every timeout
until the user says in the conversation that the review is finished. Each comment names
its document: mark it with `paved preview working <target> <comment-id> --json`, apply
it, then `paved preview resolve <target> <comment-id> --reply "<what changed>" --json`.
After editing, run `paved plan --run <run-id> --advance` once to request approval for the
revised plan hash. A result that waits on a person about a document carries a `review`
block naming the document to open; the Intent while its classification is pending, the
plan with the documents of the same run, and the review record rendered in the `review`
phase all reach the person this way.

The preview approves nothing. Ask for the approval in the conversation, and only after
an explicit yes to the current plan run `paved plan --run <run-id> --approve`: it
records the decision for the exact plan version, under the local user, and resumes. An
unclear reply, silence or your own judgment is never an approval.

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
