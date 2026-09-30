# Task quality

The bar a task meets before it goes to the tracker. `task-specification` checks its own
draft against it; `task-review` checks an existing task against it.

## Per section

| Section | Meets the bar when | Common defects |
|---|---|---|
| Type | Matches the content (a bug describes a deviation, technical debt changes no behavior) | A feature filed as a bug to jump the queue; a refactor filed as a feature |
| Description | Says what and why; a newcomer understands it without a meeting | Only a title restated; the solution with no problem |
| Expected result | Describes observable behavior | Describes implementation ("add a column") instead of outcome |
| Acceptance criteria | Each line is observable, binary and testable by someone other than the author | "Works correctly", "is fast", "good experience"; several conditions in one line |
| Technical context | Every path, component or endpoint named exists in the repository, or is marked as new | Invented or stale paths; a pattern that contradicts the project's rules |
| Steps to reproduce | Someone else can follow them from a stated starting state and see the defect | Missing starting state; actual and expected result mixed together |

## Verifiable criteria

A criterion is verifiable when you can name the check that proves it: an automated test
at some level, a check in the project's verification profile, or an explicit manual
verification someone performs. Replace vague terms with the measure behind them:

| Vague | Verifiable |
|---|---|
| The page loads fast | The list shows its first 50 items within the budget in the verification profile |
| The error is handled | When the payment provider times out, the order stays pending and the user sees a retry option |
| Works on all devices | The flow completes at the smallest viewport the project supports |

When the repository has no check that could prove a criterion, keep the criterion and say
it needs manual verification or a new check; do not drop it.

## When to split

Split a request into several tasks when any of these holds:

- It has more than one expected result that could be delivered and used on its own.
- It needs more than about seven acceptance criteria, or criteria for unrelated flows.
- It crosses a boundary that different people or deployable units own, and each side can
  ship without the other.
- Part of it is uncertain (an open question, an unknown dependency) and part is not.

Split vertically: each task delivers a thin slice of the outcome through every layer it
needs, and is verifiable on its own. Do not split by layer (one task for storage, one
for the interface) unless the layers really ship separately. Order the tasks, state
which depends on which, and put the uncertain part first or in its own investigation
task.

## Grounding in the repository

- A path, component, endpoint, screen or configuration named in the task exists, or the
  task says it is new.
- The pattern to follow points at a real sibling that does something similar.
- Constraints come from the project's rules, architecture and integrations context, with
  the source named.
- A premise the repository contradicts is raised, not silently corrected.
- A premise the repository cannot confirm or deny is an open question.
