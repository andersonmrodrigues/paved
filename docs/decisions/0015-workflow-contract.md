# 0015. Workflow contract, run state and no workflow composition

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The first workflows listed phases, suggested skills, check types and gates with a
`human_approval` flag. They could not say what a run needs to start, what completion
requires beyond the Core criteria, which failures are safe to retry, why a human must
decide, or where a run stands. Execution semantics lived nowhere, so each workflow would
have had to repeat them, and tools' safety classes were not connected to workflows.

## Decision

- `workflow.yaml` gains `description` ("Use when …"), `version` and `status` (the skill
  lifecycle model), `inputs`, `context`, `preconditions`, `rules`, `evidence.required`,
  `outputs` and `completion.criteria`. Phases gain `tools`, `verification {required,
  recommended}` (replacing `check_types`), `skip_when` and `retry`. The field stays
  `phases`: a stage is a lifecycle phase.
- Gates gain `when` (conditional) and `approval` (a category), replacing
  `human_approval`. Overrides add gates in the same shape.
- A shared failure vocabulary (`failureCode`) and retry classes (`retryClass`), with one
  table mapping each code to a run status and class.
- A `WorkflowRun` document records one run's state and events under
  `.paved/generated/runs/`. It is a record, not an engine.
- Execution semantics live once, in `core/instructions/workflows.md`.
- Workflows do not invoke workflows; a follow-up is an output.
- Checks the schema cannot express live in `cli/lib/workflows.ts`: order, safety,
  verifiability, duplicate skill activation, genericity, run consistency, evidence
  against the workflow.

## Consequences

- Every Core workflow changed shape and is `0.2.0`, `experimental`. Project workflows
  and overrides using `human_approval` or `check_types` must migrate (breaking, within
  `0.x`).
- Tool safety is enforced through workflows: a phase reaching a destructive tool needs a
  `destructive-operation` approval and no automatic retry.
- The run record is only as reliable as whoever writes it until a runner exists;
  approvals are recorded, not authenticated.

## Alternatives considered

- **Rename `phases` to `stages`.** Rejected: a breaking rename with no gain; stages are
  lifecycle phases.
- **Workflow composition (a workflow invoking another).** Rejected: nested runs need
  shared state, nested failure and nested approval semantics. Two runs with a follow-up
  output are simpler to review.
- **Run state only in the evidence record.** Rejected: evidence is about claims and
  proofs; mixing progress, approvals and retries into it would blur what it proves.
- **A workflow engine.** Out of scope: Paved defines contracts agents follow; a runner
  may come later and would consume the same records.

## References

- [workflows](../concepts/workflows.md), [workflow stages](../concepts/workflow-stages.md),
  [workflow failure](../concepts/workflow-failure.md),
  [workflow approval](../concepts/workflow-approval.md),
  [workflow state](../concepts/workflow-state.md)
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/ipd)
