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
  items when requested"), not as implementation steps. Choose the lightest planning
  track whose conditions hold:
  - **Lightweight:** use only when the request and acceptance behavior are clear, the
    change is bounded to one area, and it is reversible without crossing an
    architectural boundary. Record a concise approach, observable claims and how each
    will be checked. Do not create separate specs or task breakdowns unless they reduce
    ambiguity or help coordinate the work.
  - **Expanded:** use when any lightweight condition does not hold, including unclear
    acceptance behavior, multiple areas, high impact or an architectural boundary.
    Resolve uncertainty and make alternatives, tradeoffs, dependencies and decomposition
    explicit before implementation.
  Both tracks require human plan approval. Neither may skip verification, evidence or
  review. The `boundary-exception` gate still needs a human. For visible frontend
  changes, `frontend-design` records a brief-grounded visual direction in the plan
  before coding.
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
