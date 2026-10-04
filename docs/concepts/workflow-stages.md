# Workflow stages

A stage of a workflow is a **phase** of the task lifecycle. The schema calls them
`phases`, and the vocabulary is fixed by the `phase` enum in the common schema, which is
also the canonical order:

```text
context → discovery → planning → implementation → validation → verification → evidence → review → completion
```

| Phase | Purpose | Required? |
|---|---|---|
| `context` | Restate the task and inputs; locate relevant context | Optional |
| `discovery` | Find where the change lives and how it is done today | Optional |
| `planning` | Decide the change and the check that proves each claim | Optional |
| `implementation` | Make the change | Optional |
| `validation` | Inner-loop checks while working | Optional |
| `verification` | Run the checks that prove the claims | **Always; never skipped** |
| `evidence` | Record claims, checks, artifacts and gaps | **Always; never skipped** |
| `review` | Check rules, patterns and unexplained changes | Optional |
| `completion` | Confirm completion criteria and report | **Always; never skipped** |

## Structure of a phase

| Field | Meaning |
|---|---|
| `phase` | Which lifecycle phase |
| `goal` | What the phase must achieve for this class of change |
| `skills` | Skills to activate, in order |
| `tools` | `required` and `optional` tools the phase uses directly |
| `verification` | `required` and `recommended` check types run in the phase |
| `gates` | Conditions that must hold before leaving the phase; `when` makes one conditional, `approval` makes it a human decision |
| `skip_when` | The only condition under which the phase may be skipped |
| `retry` | `class` and, for `retryable`, `max_attempts` (1-5; default 2) |

## Ordering

Order is deterministic: phases appear in canonical order, each at most once
(`assessWorkflowQuality`), and a run executes them in that order, one at a time
(`assessRun`: no phase starts before every earlier phase is completed or skipped). A
workflow omits what never applies to its class of change (the `refactor` workflow has no
gate in `context`). A phase
present in the workflow is always run unless its `skip_when` holds.

## Skipping

Skipping is a declared deviation, never a silent one:

- only a phase with `skip_when` may be skipped, and only when that condition holds;
- the run records the phase as `skipped` with a `skip_reason` saying how the condition
  holds, and a `phase-skipped` event;
- `verification`, `evidence` and `completion` cannot declare `skip_when` (schema).

The Core catalog uses no skip.

## Deviations from the canonical flow

When the natural flow of a class of change does not match the canonical order, the
workflow keeps the canonical order and says in `WORKFLOW.md` where the work happens:

- **Release:** publishing and post-release verification happen in `completion`, after
  the `release` approval, because publishing must follow every check on the candidate.
  The post-release `runtime` check is a required check of the completion phase and is
  appended to the same evidence record.
- **Incident:** containment may precede investigation (the `discovery` skip above).
