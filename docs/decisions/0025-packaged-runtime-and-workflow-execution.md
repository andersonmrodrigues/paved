# 0025. Packaged runtime and executable workflow state

- **Status:** Accepted
- **Date:** 2026-09-28
- **Extends:** [0015](0015-workflow-contract.md), [0022](0022-consumer-lifecycle-and-atomic-local-update.md), [0024](0024-agent-integration-projections.md)

## Context

Paved had a compiled CLI, workflow and Tool contracts, verification, and agent
command projections. A clean consumer still needed an accessible Core checkout,
and `WorkflowRun` records did not drive execution. Installing a global CLI or
letting each agent implement its own workflow would split command semantics.

## Decision

- Each agent projection includes a small Node launcher and a pinned package
  version. The launcher obtains `paved-core` through npm, checks the package's
  SHA-512 integrity, installs it only under `.paved/runtime/`, validates an
  installed content digest before each command, and calls the packaged CLI.
- `.paved/paved.lock` records the selected package name, version, integrity and
  installed content digest. The lock wins over a newer integration pin. Existing
  locks without a runtime field continue to work through the direct CLI and
  require an explicit migration for the launcher.
- `cli/runtime.ts` remains the canonical dispatcher for CLI and agent calls.
  `feature`, `fix`, and `refactor` advance the existing workflow contract's
  `WorkflowRun` through durable phase state. `plan`, `debug`, `implement`, and
  `review` enter those same runs. Validation calls the governed testing Tool;
  verification calls the existing verification engine; completion checks
  workflow evidence against authoritative check results.
- A plan-specific human decision is stored outside generated run state and
  checked on resume. Generated run edits or command arguments alone cannot
  satisfy approval. Local same-user filesystem access is not an adversarial
  identity boundary.

## Consequences

- The packaged runtime and native integrations share command behavior without
  adding application dependencies or a second workflow engine.
- Bootstrap requires a published pinned package for public registry use. A local
  tarball path supports release tests. Runtime version updates and rollback need
  a separate validated transaction before they can be exposed publicly.
- Core workflows `feature`, `bug`, and `refactor` advance to experimental
  version `0.3.0` because a required approval gate changes completion rules.

## Alternatives considered

- **Global installation.** Rejected because it is not project pinned or isolated.
- **Agent-specific execution prompts.** Rejected because they cannot enforce the
  same approval, Tool, evidence, and verification path.
- **Remote shell installer.** Rejected because it would execute unverified code.

## References

- [Agent command reference](../concepts/agent-commands.md)
- [Workflow state](../concepts/workflow-state.md)
- [Runtime package smoke test](../../tests/package/bootstrap.test.ts)
