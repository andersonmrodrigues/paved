# 0028. Conversational decision resolution

- **Status:** Accepted
- **Date:** 2026-09-28

## Context

Paved already has evidence-driven resolution and workflow approval gates, but material
project choices were either implicit or left to hand-editing configuration. Agent
integrations also lacked one result shape and interaction protocol for asking, resuming
and auditing such choices. Treating every uncertainty as a question would let answers
bypass missing prerequisites, integrity failures and unknown compatibility.

## Decision

Use a schema-validated `Decision` record and one gate for project- and run-scoped
material choices. Classify conditions as deterministic, material or unsafe: deterministic
outcomes reuse their existing authoritative stores; material choices may be asked and
applied; unsafe conditions stay blocking diagnostics. Keep answers in the originating
command flow, expose decisions at the top level of results, and make agent projections
reference one canonical decision skill.

Project decisions live under `.paved/decisions/`; run decisions live in their
`WorkflowRun`; human-authored approvals live under `.paved/approvals/`. Effect classes
fix the required answer channel. The fingerprint binds only cited evidence and candidates,
so unrelated changes do not cause stale questions.

## Consequences

Required decisions pause a command with `awaiting_input` and exit code 10. Optional
decisions are advisory and do not pause execution. Agents can relay explicit user answers
but cannot choose options, invent identities or author human approvals. A changed decision
is superseded and re-asked; a blocker cannot be answered away. Existing valid
configuration remains supported without fabricated decision history.

## Alternatives considered

- **Extend `GateRecord` with all project and run decisions.** Rejected: a workflow gate
  records satisfaction of one workflow condition, while a Decision has its own scope,
  candidate fingerprint, answer contract, options and invalidation lifecycle. Folding the
  models together would couple workflow state to project configuration decisions.
- **Create a standalone decision store independent of `WorkflowRun`.** Rejected: a
  run-scoped decision belongs to that run's lifetime and should be removed with its
  disposable record. A second file would create split persistence and recovery ordering.
- **Treat unsafe conditions as questions.** Rejected: an answer cannot make missing
  evidence, integrity or compatibility safe. Those remain diagnostics.
- **Write deterministic resolutions as Decision records.** Rejected: existing stores
  such as `paved.lock` already hold the authority and provenance; duplicate records would
  imply a human answer that never happened.

## References

- [Conversational decisions](../concepts/decisions.md)
- [Agent integration contract](../concepts/agent-integration.md)
- [Workflow state](../concepts/workflow-state.md)
- [ADR 0027: Scoped capability provider resolution](0027-scoped-capability-provider-resolution.md)
