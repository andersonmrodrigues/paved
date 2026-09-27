# Changelog

All notable changes to Paved Core are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in
[docs/concepts/versioning.md](docs/concepts/versioning.md).

## [Unreleased]

Architecture and Core design, schemas and contracts, the skills architecture, the
workflows architecture, the Verification and Evidence architecture, and the Tools
architecture and implementation contracts.
Contains breaking schema changes, allowed within `0.x` (see versioning).

### Added

- `Check` schema, check definitions, a profile of check ids, and generic Core checks
  wired through Tool contracts.
- Deterministic completion assessment with required check outcomes, revision binding,
  bounded retries, flaky detection and performance measurement comparison; synthetic
  verification tests and evidence fixtures.
- Verification concepts, CLI contracts, ADR 0016 and verification review.
- Tool capability and ToolImplementation schemas, generic Core capability catalog,
  implementation bindings, restrictive project override operations, Tool discovery and
  resolution/policy/evidence-capture library, synthetic fixtures and tests; ADRs 0017
  and 0018; Tool architecture, safety, resolution, results and CLI contracts.

- Skills: `refactoring`, `prototyping`, `bug-investigation`, `runtime-debugging`,
  `unit-testing`, `integration-testing`, `e2e-testing`, `backend-performance`,
  `frontend-performance`, `threat-modeling`; references and synthetic examples for
  `context-discovery`, `bug-investigation`, `profiling` and `threat-modeling`.
- Tool `core.git.log` (read-only).
- `cli/lib/skills.ts`: skill quality checks, dependency cycles, duplicated sentences,
  unproving required checks, and evidence assessed against producer skills. Optional
  references (`tools.optional`, `depends_on.optional`) may be absent during resolution.
- `docs/concepts/skills.md`, `skill-discovery.md`, `progressive-disclosure.md`,
  `skill-composition.md`; ADR 0014; `docs/getting-started/skills-review.md`.
- `WorkflowRun` document kind (`schemas/workflow-run.schema.yaml`), template and consumer
  path `.paved/generated/runs/` (disposable): run status, phases, attempts, gates,
  approvals, failure, outputs and events.
- Common definitions `approvalCategory`, `gate`, `lifecycleStatus`, `deprecation`,
  `failureCode`, `retryClass`.
- `core/instructions/workflows.md`: preconditions, inputs, phase execution, gates and
  approvals, safe autonomy, failure codes, retry and completion for every workflow.
- `cli/lib/workflows.ts`: `assessWorkflowQuality`, `assessRun`, `assessWorkflowEvidence`
  and the `FAILURE_CODES` table; workflow quality, run and evidence fixtures.
- `docs/concepts/workflows.md`, `workflow-stages.md`, `workflow-failure.md`,
  `workflow-approval.md`, `workflow-state.md`; ADR 0015;
  `docs/getting-started/workflows-review.md`.

- `provenance` schema (the single provenance definition) and `generated-artifact` schema
  (kind `GeneratedArtifact`, sidecar metadata for generated files); generator outputs
  declare `metadata: inline | sidecar` (ADR 0013).
- Qualified reference formats (`ruleRef`, `toolRef`, `skillRef`, `workflowRef`) and
  namespaces `core`, `adapter-<name>`, `project` (ADR 0012); reference resolution and
  visibility checks in `cli/lib/references.ts`.
- `checkApiVersion`: missing, malformed, newer, older and unsupported `apiVersion` are
  reported before schema validation.
- `cli/lib/provenance.ts`: cited sources must be declared; managed blocks must be well
  formed and uniquely identified.
- Evidence: `inconclusive` check status, `human` artifact recorder, `verification`
  profile reference, `execution.environment`; the semantic assessment enforces
  `policy.minimum_recorder` and ignores agent-recorded reviews and manual observations
  (`self_reportable: false` in the registry).
- Feature: `actors`, typed `code.entrypoints`, `data`, `dependencies`.
- Project manifest `project.owners`; Core manifest `schema_definitions`; adapter `title`;
  verification profile check `tool`.
- Valid and invalid fixtures for every schema; reference and provenance fixtures.
- `docs/concepts/schemas.md`, `contracts.md`, `references.md`; ADRs 0012 and 0013;
  `docs/getting-started/schema-review.md`.

- `components` dependency model in the Core manifest, enforced by
  `tests/core/boundaries.test.ts`.
- `Lock` and `ContextDocument` document kinds, with templates and fixtures.
- Knowledge-state and provenance model: identified sources (`file`, `revision`, `human`,
  `url`, `command`), `conflicts`, per-block source citations.
- Evidence observation metadata: `execution.recorded_by`, revisions on checks and
  artifacts, `completion.decided_by`; revision-consistency check in `cli/lib/evidence.ts`.
- Verification profile `policy.minimum_recorder`.
- `.paved/workflows/` for project workflows; `required` and `schema` on every consumer
  layout entry.
- Principle 11, "Fail explicitly, toward the stricter behavior", and the
  *overrides need review* repository state.
- Architecture documentation (boundaries, inheritance, context loading, verification,
  traceability, multi-repository, failure handling, Gardener, extensibility), eleven
  ADRs, and an enforcement-candidates list.

### Changed

- **Breaking:** Tool documents now describe versioned capabilities and no longer embed
  invocation commands. `ToolImplementation` documents bind capabilities to executable
  mechanisms; Tool safety values are `read-only`, `safe-mutation`, `destructive` and
  `high-impact`. Overrides may restrict inherited Tools or explicitly select a compatible
  binding, but cannot weaken contract policy.
- **Breaking:** evidence and verification profile contracts now use a task plan,
  revision-bound check results and check ids. A required gap leaves completion
  incomplete; partial verification is reported separately from task status.
- `feature-development` moves to `0.2.1` to describe Check → Tool capability resolution;
  agent workflow instructions and integration guide use the same contract.
- `repository-onboarding` moves to `0.2.2` to describe unresolved Tool capability
  implementations as blocked checks rather than guessed commands.

- **Breaking:** workflow contract (ADR 0015). `workflow.yaml` requires `description`,
  `version`, `status`, `inputs`, `evidence`, `outputs` and `completion`; phases use
  `verification {required, recommended}` instead of `check_types` and may declare
  `tools`, `skip_when` and `retry`. Workflow references to rules and phase tools are
  resolved.
- **Breaking:** gates use `approval: <category>` (and optional `when`) instead of
  `human_approval: true`, in workflows and in override `add_gates`.
- All six Core workflows rewritten on the new contract at `0.2.0` (`experimental`),
  with inputs, approvals where they act on shared systems (incident, release),
  conditional exception gates and completion criteria. `WORKFLOW.md` sections are now
  When to use, Phases, Escalation; completion criteria live in `workflow.yaml`.
- Skill `status` and `deprecation` use the shared common definitions.
- `lifecycle.md` and `AGENTS.md` point to `workflows.md`; skipping requires `skip_when`.

- **Breaking:** skill contract (ADR 0014). `skill.yaml` requires `version` and `status`
  (`deprecation` iff deprecated); `tools` and `depends_on` have `required` and
  `optional`; `verification.check_types` is replaced by `required` and `recommended`;
  `references` accepts `references/`, `examples/`, `scripts/` and `assets/` files.
- **Breaking:** skills renamed: `core.development.implement-change` →
  `core.development.feature-development`, `core.performance.performance-investigation` →
  `core.performance.profiling`. Workflows reference the new and added skills.
- **Breaking:** the Core manifest requires `context_areas`, mapping each context area to
  its consumer path.
- `core/instructions/AGENTS.md`: skill activation and loading order, a table of
  generic responses when a skill cannot proceed, and a search order for unknowns.
- Skill template: every section required, 150-line body, activation phrase in the
  description.

- **Breaking:** skills and workflows are identified by qualified `id`
  (`core.debugging.root-cause-analysis`, `core.bug`) instead of `name`; workflows,
  evidence and overrides reference them by id.
- **Breaking:** override entries use `target` (qualified id) and require `owner`.
- **Breaking:** context areas drop the `project.` prefix (`domain`, `feature-map`) and
  gain `technology`.
- **Breaking:** evidence requires `change.revision` and a `severity` on rule entries;
  only a violated `error` rule blocks completion; artifact `ref` is replaced by `source`.
- **Breaking:** `feature.code.entrypoints` entries are typed objects; `related_features`
  is replaced by `dependencies.features`.
- **Breaking:** adapter `requires.adapters` entries are `{id, version}`; semver ranges must
  name full versions (`latest` and wildcards are rejected).
- **Breaking:** generated provenance requires `generator_version` and `output_sha256`.
- Schemas renamed: `context.schema.yaml` → `project-context.schema.yaml`,
  `overrides.schema.yaml` → `override.schema.yaml`. Managed blocks close with
  `<!-- paved:end generated -->` / `<!-- paved:end managed -->`.
- **Breaking:** overrides use typed operations with an explicit `action` for skills
  (`extend`, `disable`) and workflows (`extend`, `disable`), and may record
  `target_sha256`.
- **Breaking:** evidence checks require `execution`, artifacts require `recorded_by`, and
  `completion` requires `decided_by`.
- **Breaking:** provenance `sources` entries are `{id, type, location, …}` instead of
  `{path, sha256}`; `generator_version` is optional (for `generator: human`).
- `docs/concepts/multi-repo-contract.md` renamed to `multi-repository.md`.

### Removed

- **Breaking:** `workflows.disabled` in the project manifest; use an override instead.

## [0.1.0] - 2026-09-27

### Added

- Architectural bootstrap of the multi-repo Core: Core, Adapters, Project Context,
  Overrides and Generated layers.
- Contract schemas (API version `paved/v1`) for manifest, adapter, feature, rule, skill,
  workflow, evidence, tool, verification profile, overrides and generator documents.
- Agent instructions, principles and task lifecycle.
- Initial domain-agnostic skills, workflows, rules and tools.
- Verification model with check-type registry and evidence contract.
- Generator contracts (not implemented).
- CLI command contracts (not implemented) and a shared validation library.
- Self-tests for schemas, templates, skills, workflows, generators and Core consistency.
