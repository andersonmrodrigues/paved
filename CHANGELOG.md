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
- A local CLI for `init`, `update`, `generate`, `verify`, `status`, `doctor`,
  `gardener` and project-local `agent` projections, with structured JSON results
  and explicit exit categories.
- Deterministic, evidence-driven project context generation with provenance,
  reviewable proposals, ownership checks and safe regeneration.
- One technology-neutral capability registry and the current Git, Java, Quarkus,
  TypeScript, Angular, Dart, Flutter and PostgreSQL adapters.
- One verification and evidence model with explicit Tool bindings, bounded
  execution, output redaction and lifecycle-aware readiness.
- Project-local Codex and Claude Code skill and command projections from shared
  Core contracts.

### Compatibility and limitations

- The Core and document API are at `1.0.0` and `paved/v1`; breaking document API
  changes require a new API version.
- Current distribution uses a local Paved Core checkout with `npm ci`; there is no
  published package, remote Core/adapter resolution or marketplace installer.
- Consumers must review generated proposals and configure an explicit verification
  profile and approved Tool bindings. Initialization does not approve or run checks.
- Automatic schema migrations and executable `paved evidence` and `paved tool`
  command families are not implemented.
- Agent projections include skills and command prompts; the local Core checkout
  and CLI remain necessary for instructions, lifecycle operations and verification.
