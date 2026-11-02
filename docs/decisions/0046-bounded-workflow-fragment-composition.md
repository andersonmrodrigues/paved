# ADR 0046: Bounded workflow fragment composition

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Workflow phases can need the same guidance and skill or Tool declarations. Copying
that material makes it drift, while invoking another workflow would introduce the
nested state, failure and approval semantics rejected by ADR 0015. Reuse needs a
boundary that leaves one workflow responsible for its phases and run.

## Decision

Add Core-owned, versioned `WorkflowFragment` contracts with guidance in
`FRAGMENT.md`. A fragment contributes only guidance, declared inputs, skills and
Tools to an owning workflow phase. Fragments cannot nest, invoke workflows or own
phases, gates, run state, lifecycle transitions or approvals. This complements
[ADR 0015](0015-workflow-contract.md)'s prohibition on nested workflow invocation;
it does not supersede that decision.

Before dispatch, resolve each phase's fragment inclusions in declaration order.
Bind every declared input exactly once from `fragments[].with`, using only exact
`{{ inputs.<id> }}` placeholders and nonblank string bindings. No expressions,
recursive templates or template-bearing bindings are supported. Reject missing or
extra bindings, unresolved placeholders, duplicate fragment inclusions and unknown
references; never return partially resolved phase guidance. Merge skills in order
with deduplication and make fragment Tools required phase Tools, preserving skill
dependency, Tool safety and workflow quality checks. Expose the resolved guidance
and declarations through the active phase context consumed by integrations.

Version fragments when guidance or declarations change. Bump every owning workflow
whose effective behavior changes, including through a referenced fragment. Optional
guidance is a compatible addition; mandatory requirements follow the existing
breaking-change rules. The feature workflow's context-discovery guidance therefore
moves its version from `0.4.0` to `0.5.0`.

The owning workflow retains its gates, approvals, required input, verification,
evidence, independent review and completion requirements. Autonomy profiles only
guide continuation and dispatch; they cannot bypass those requirements or host
permissions. Phase-selected Tool policy actions remain host-neutral: `allow` is a
recommendation subject to host permission, `ask` requires host-mediated approval,
and `deny` excludes use. Validate policies against composed required Tools before
dispatch; fragments cannot relax these boundaries.

## Consequences

Guidance and declarations can be reused without a second run or hidden approval
scope. Authors must bind inputs explicitly and review version changes for every
affected workflow when shared fragment behavior changes. Integrations receive a
fully resolved active phase rather than implementing their own template semantics.
The owning workflow remains the sole authority for orchestration and run state.

## Alternatives considered

- **Copy guidance into each workflow.** Simple initially, but shared procedures and
  declarations can diverge without a reusable contract.
- **Invoke another workflow.** Rejected for the nested state, failure and approval
  semantics recorded in ADR 0015.
- **Allow nested fragments or general templates.** Adds recursive resolution and
  implicit behavior beyond the bounded reuse this contract needs.
- **Let fragments add gates or approvals.** Hides orchestration requirements outside
  the owning workflow and makes its effective control flow harder to review.

## References

- [ADR 0015](0015-workflow-contract.md)
- [Workflows and fragment composition](../concepts/workflows.md#reusable-workflow-fragments)
- [Workflow versions](../concepts/versioning.md#workflow-versions)
- [WorkflowFragment schema](../../schemas/workflow-fragment.schema.yaml)
- [Workflow schema](../../schemas/workflow.schema.yaml)
- [Evolving the Core](../maintenance/evolving-the-core.md)
