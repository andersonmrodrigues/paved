# ADR 0036: Intent, plan and execute

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Paved 1.x projected fifteen agent commands. Seven of them reached only three executable
workflows: `feature`, `fix` and `refactor`, plus `plan` (an alias of `feature`), `debug`
(an alias of `fix`), and `implement` and `review`, which resumed a run in a given phase.
Users had to know the kind of change before starting, and learn a long command list.

The three workflows are genuinely different contracts: a bug needs a failing regression
test first, a refactor a behavior baseline, a feature claims mapped to checks. They do not
need different entry points. Every one of them already has the same human checkpoints:
understand the change, approve a plan, prove the result.

Three more Core workflows, `performance`, `incident` and `release`, had contracts that no
command executed. `performance` also depended on measurements the verification runner
does not capture.

## Decision

- Every repository change goes through three steps over one run: `intent` classifies the
  request and runs `context` and `discovery`; `plan` runs `planning` and records the
  approval the user gives in the conversation; `execute` runs `implementation` through
  `completion`. Each step owns a fixed range of phases, enforced by the runtime
  (`PAVED_WORKFLOW_STEP_OUT_OF_RANGE`).
- The agent classifies only with evidence (`--workflow <id> --because "<evidence>"`). When
  the kind of change is uncertain, the user decides through a decision; a mixed request
  becomes a split decision. Paved never guesses.
- Paved projects seven agent commands: `init`, `status`, `intent`, `plan`, `execute`,
  `preview` and `update`. `test`, `verify`, `doctor` and `gardener` stay as CLI
  subcommands for CI, the launcher and the runtime.
- `status` absorbs `doctor`: its diagnostics and its repair decisions. It stays read-only
  unless the user answers a repair decision.
- The gardener runs at the end of `execute` and lists only proposals not reported before.
  It is advisory and never blocks completion; adopting a proposal stays with
  `paved gardener`.
- Gate logic moves to one handler module per workflow (`cli/lib/workflow-gates/`), and a
  test requires every gate of every Core workflow to have a handler.
- `performance`, `incident` and `release` are removed. A performance improvement runs as
  `refactor` (behavior unchanged) or `feature` (a new budget).
- The commands and workflows are removed in 2.0.0 without a deprecation release. This is
  an exception to the deprecation policy in [versioning](../concepts/versioning.md#deprecation):
  keeping two command surfaces for a minor release would have meant two sets of
  instructions, projections and tests for the same runs, and the removed workflows never
  ran.

## Consequences

- Consumers migrate ([migrating to 2.0](../getting-started/migrating-to-2.md)). Plugin
  consumers update the plugin; project-local projections are pruned by
  `paved agent update`; `paved update` rewrites the managed `AGENTS.md` block.
- Runs created by 1.x keep working: the workflow comes from the run, so the step that owns
  the run's current phase resumes it.
- A consumer override that targets `core.performance`, `core.incident` or `core.release`
  fails with `PAVED_OVERRIDE_TARGET_MISSING` until its owner removes or retargets it.
- A Core workflow can no longer ship without the code that executes it.

## Alternatives considered

- **Keep the 1.x commands as deprecated aliases for one minor release.** Rejected: each
  alias needs its own instructions, projection and tests, and the agents would keep
  choosing between two surfaces for the same run.
- **One command per workflow, plus `plan` and `execute`.** Rejected: users would still
  have to classify the change before starting, which is the problem being solved.
- **Keep `performance`, `incident` and `release` as documented contracts.** Rejected: a
  contract nothing executes reads as supported behavior.

## References

- [Agent command reference](../concepts/agent-commands.md)
- [Workflows](../concepts/workflows.md)
- [Workflow steps](../../cli/commands/workflow.ts)
- [Gate handlers](../../cli/lib/workflow-gates/index.ts)
- [Gate coverage test](../../tests/workflows/gates.test.ts)
