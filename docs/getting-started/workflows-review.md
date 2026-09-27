# Workflows review

What the workflows pass defined, which decisions it made, and what it left open. The
workflows are **well formed, ordered, safe with respect to tool classes, verifiable and
consistent with the skills they orchestrate**, and tests hold them to that. Nothing here
shows they are *good*: no agent has run them on a real repository, no runner executes
them, and run records are written by whoever runs the workflow, not by Paved. Paved is
**not production ready**.

## Starting point

Six workflows existed with phases, suggested skills, `check_types` and gates with a
`human_approval` flag. They had no inputs, no version, no completion criteria of their
own, no failure or retry semantics and no link to tool safety. This pass extended that
format ([ADR 0015](../decisions/0015-workflow-contract.md)); it did not add a competing
abstraction.

## Research

| Source | Influence |
|---|---|
| [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Workflows as predefined orchestration; human checkpoints; stopping conditions |
| [Temporal retry policies](https://docs.temporal.io/encyclopedia/retry-policies) | Bounded attempts; non-retryable error types |
| [GitHub deployment environments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment) | Required reviewers as approval gates; the requester cannot self-approve |
| [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/ipd) ([announcement](https://www.nist.gov/news-events/news/2025/04/nist-revises-sp-800-61-incident-response-recommendations-and-considerations)) | Incident flow: detection, analysis, containment, recovery, lessons learned |

## Summary

| Area | Result | Where |
|---|---|---|
| Architecture | Contract (`workflow.yaml`), guidance (`WORKFLOW.md`), execution semantics once (`instructions/workflows.md`), run record, library checks | [workflows](../concepts/workflows.md) |
| Contract | Metadata, inputs, context, preconditions, rules, phases, evidence, outputs, completion; lifecycle as skills | [workflow schema](../../schemas/workflow.schema.yaml) |
| Stage model | Stages are the nine lifecycle phases; canonical order; `skip_when`; three phases unskippable | [workflow stages](../concepts/workflow-stages.md) |
| Skill composition | Ordered per phase, activated once and continued, no duplicate activation of dependencies, at most three per phase | [workflows](../concepts/workflows.md#skill-composition) |
| Rule resolution | Workflow rules ∪ skill rules ∪ `applies_to` matches, then overrides; severity never changed by a workflow | [workflows](../concepts/workflows.md#rule-resolution) |
| Tool resolution | Phase tools plus skill tools; required must resolve; destructive tools need a `destructive-operation` approval and no auto-retry | [workflows](../concepts/workflows.md#tool-resolution) |
| Verification | Mandatory phase; `required`/`recommended` per phase; required types must prove something | [workflows](../concepts/workflows.md#verification-and-evidence) |
| Evidence | `producer.workflow`; required checks of all phases and required evidence kinds (`assessWorkflowEvidence`) | same |
| Completion | completed / completed-with-warnings / failed / blocked, mapped to evidence status | same |
| Failure | Thirteen codes, one table mapping each to run status and retry class | [workflow failure](../concepts/workflow-failure.md) |
| Retry | retryable (bounded, default 2, max 5) / non-retryable / requires-human; evidence kept; exhaustion escalates | same |
| Approval | Gates with `approval` categories and `when`; decided by a named person | [workflow approval](../concepts/workflow-approval.md) |
| State | `WorkflowRun` record and events; not an engine | [workflow state](../concepts/workflow-state.md) |
| Catalog | feature, bug, refactor, performance, incident, release at `0.2.0` experimental | [catalog](../../core/workflows/README.md) |

## Validation strategy

| Layer | Checks |
|---|---|
| Schema | Required fields; unskippable phases; retry shape; approval categories; lifecycle status vs version; gate records decided by a person; failure required when failed or blocked |
| `assessWorkflowQuality` | Order; unique gates; "Use when"; no technology or identifiers; ≤80 lines; ≤3 skills per phase; contract mentioned in `WORKFLOW.md`; provable verification for code changes; destructive tools gated; release and incident approvals; duplicate activation; deprecated skills; cycles; copied sentences |
| `resolveReferences` | Skills, phase tools (optional may be absent) and rules exist and are visible |
| `assessRun` | Version and phase list match; inputs; ordering; skips; attempts; gate satisfaction; single running phase; failure code consistency |
| `assessWorkflowEvidence` | Evidence satisfies the workflow |
| Fixtures | 11 invalid and 2 valid workflow schema fixtures; 6 invalid and 3 valid run schema fixtures; 10 invalid and 1 valid quality fixtures; 9 unsound and 3 sound run fixtures; 3 unsound and 1 sound evidence fixtures |

`npm run check` (strict `tsc` plus all tests) passes. No linter is configured.

## Audit (§39)

| # | Question | Finding |
|---|---|---|
| 1 | Domain-agnostic? | Yes. The genericity scan runs on every description and `WORKFLOW.md`; inputs and gates speak of "the affected system", "the project's procedure" |
| 2 | Project, technology or tool assumptions? | None in Core workflows. Release defers registry, tag format and branch model to project context; incident names reversible mitigations generically |
| 3 | Duplicated skill logic? | Checked: no sentence of a reachable skill is repeated, and required dependencies are not listed again |
| 4 | Hidden side effects? | Phases can only use listed tools and their skills' tools; safety classes carry through; all Core tools are read-only |
| 5 | Verification mandatory? | Yes, and unskippable; code-changing workflows must require a provable check type |
| 6 | Evidence mandatory? | Yes: evidence phase unskippable, `evidence.required` non-empty for code changes, evidence checked against the workflow |
| 7 | Completion unambiguous? | Standard rule plus per-workflow criteria; four outcomes mapped to evidence status. Criteria are still prose judged by the agent |
| 8 | Failure explicit? | Yes: coded, phased, with next action and retry class |
| 9 | Retry bounded? | Yes: at most 5 attempts, default 2; destructive phases never auto-retried |
| 10 | Approvals where required? | Incident (every mitigation), release (publishing), conditional exceptions in feature, refactor and release; enforced for release and incident |
| 11 | Excessive complexity? | Largest `WORKFLOW.md` is under 40 lines; at most two skills per phase in the catalog. The contract has many optional fields; each Core workflow uses only some |
| 12 | Competing abstractions? | None: no workflow composition, no engine, no second skill or rule mechanism |
| 13 | Deterministic ordering? | Yes, canonical order; runs checked phase by phase |
| 14 | Consistent with Core contracts? | References resolve; lifecycle model, qualified ids, overrides and evidence registry reused |
| 15 | Production-ready? | **No.** See below |

## Unresolved decisions

- **Release deviation.** Publishing and post-release verification sit in `completion`,
  after the `release` approval, and the runtime check is appended to the same evidence
  record. A separate post-release phase would break the canonical order; a second
  workflow would need composition. Revisit if real release runs show this confuses
  agents.
- **Conditional gates are judged by the agent.** `when` and `skip_when` are prose; an
  agent decides whether they hold and records why. Nothing verifies that judgement.
- **Approval identity is not verified.** `decided_by` is a string. Real enforcement
  needs a runner or CI integration (protected environments, signed approvals).
- **Retry defaults.** Two attempts per phase is a guess; no data supports it yet.
- **High-risk change types** are a fixed map in code (release, incident); projects cannot
  add their own without a project workflow.
- **Effective set.** Checks run over Core content; overrides (`add_gates`,
  `require_checks`) are not yet applied to workflows by any code.

## Future work

- A runner or CLI command (`paved run`) that writes run records, requests approvals and
  enforces gates, consuming the same schemas.
- `paved doctor` validating run records and evidence against the effective workflow.
- Measuring whether agents following these workflows produce better changes than
  without them, starting with bug and feature.
- Approval integration with change-request reviews or deployment environments.
- Project-declared high-risk change types and approval requirements.
