# Changelog

Notable user-facing changes to Paved Core are recorded here. This file describes
releases, not the development sequence used to build them.

## [1.0.0] - Unreleased

This is the planned first stable public release. It has not been published or
tagged yet.

### Added

- Shared lifecycle-aware agent command contracts for Codex and Claude Code, with
  structured discovery, command resolution and agent-native command projections.
- Stable `paved/v1` document contracts for Core and Project manifests, locks,
  adapters, capabilities, context, rules, skills, workflows, Tools, verification,
  evidence, generators, provenance and agent integrations.
- A local CLI for `init`, `update`, `generate`, `test`, `verify`, `status`,
  `doctor`, `gardener` and project-local `agent` projections, with structured
  JSON results and explicit exit categories. `test` requires an explicit
  testing Tool and ToolImplementation, and records non-verification evidence.
- Deterministic, evidence-driven project context generation with provenance,
  reviewable proposals, ownership checks and safe regeneration.
- One technology-neutral capability registry and the current Git, Java, Quarkus,
  TypeScript, Angular, Dart, Flutter and PostgreSQL adapters.
- One verification and evidence model with explicit Tool bindings, bounded
  execution, output redaction and lifecycle-aware readiness.
- Project-local Codex and Claude Code skill and command projections from shared
  Core contracts.
- A compiled npm CLI package entrypoint and clean-consumer tarball smoke coverage;
  the package is packable but has not been published.
- Project-local agent bootstrap that verifies package SHA-512 integrity, installs
  under `.paved/runtime/`, pins runtime identity in `.paved/paved.lock`, supports
  offline reuse, and rejects corrupt installed content.
- Durable `feature`, `fix` and `refactor` workflow commands, with plan approval,
  governed test execution, authoritative verification, and evidence gates.

### Compatibility and limitations

- The Core and document API are at `1.0.0` and `paved/v1`; breaking document API
  changes require a new API version.
- No package has been published. The agent launcher supports npm acquisition,
  while the clean-room test uses a verified local tarball. A public integration
  installer or download location is still required.
- Consumers must review generated proposals and configure an explicit verification
  profile and approved Tool bindings. Initialization does not approve or run checks.
- Automatic schema migrations and executable `paved evidence` and `paved tool`
  command families are not implemented.
- Application code changes and review observations remain agent actions recorded
  in the durable workflow. The runtime enforces phase order, required approval,
  governed testing, verification and evidence before completion.
- Runtime version updates and rollback across published package versions are not
  implemented; `paved update` still updates local Core inputs transactionally.
