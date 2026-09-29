# Feature

## When to use

Adding behavior or changing existing behavior on purpose. If the current behavior is
wrong rather than insufficient, use `bug`. If behavior must not change, use `refactor`.
The `request` input is the anchor: without it the run stops as `input-missing`.

## Phases

- **context:** ask when the request leaves a behavior open; do not pick one silently.
  Restate every input in the run record, marking what a human said and what you read.
- **discovery:** find the sibling feature closest to this one; it is the pattern that
  `core.architecture.follow-existing-patterns` asks you to follow.
- **planning:** write claims as observable behavior ("the export includes archived
  items when requested"), not as implementation steps. If the plan crosses a declared
  boundary, the `boundary-exception` gate needs a human. For visible frontend changes,
  `frontend-design` records a brief-grounded visual direction in the plan before coding.
- **implementation:** `feature-development` hands test writing to the testing skills.
  For visible frontend changes, use `frontend-design` to inspect the rendered result and
  check responsive and accessible interaction states.
- **validation / verification:** validation keeps you honest while working;
  verification proves the claims. Missing check types become recorded gaps.
- **review:** `change-review` brings in `security-review` when the feature adds input,
  access paths or data exposure.

## Escalation

Stop and ask when acceptance behavior is ambiguous, when the change needs to cross a
declared architectural boundary, or when no check can prove a core claim and the
risk of the gap is high.
