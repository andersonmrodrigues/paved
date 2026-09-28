# Changelog

Notable user-facing changes to Paved Core are recorded here. This file describes
releases, not the development sequence used to build them.

## [1.1.0] - Unreleased

### Changed

- Automatic scoped capability provider resolution for multi-stack repositories.

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
- Native plugin installation for Codex and Claude Code through GitHub-backed
  marketplace distribution from this repository: a generated `plugins/paved/`
  plugin with one skill per command, the shared launcher, and a bundled,
  integrity-pinned `paved-core` runtime that activates offline.
- Launcher `runtime status`, `runtime upgrade` and `runtime rollback`. A different
  runtime is activated only through the Core's transactional update, with the
  previous lock and runtime kept for rollback; legacy locks without a runtime are
  adopted the same way.
- Pre-extraction archive inspection (links, traversal, special bits, unexpected
  executables), stale bootstrap-lock recovery and structured I/O failures.
- Scoped capability provider resolution: in multi-stack repositories, `init`
  resolves each capability per directory from repository evidence instead of
  reporting ambiguity. `capability_providers` also accepts a list of
  `{ path, provider }`. Provider decisions and their provenance are recorded in
  `paved.lock`, and reported by `status` and `agent commands --json`.

### Changed

- `technology/angular` 0.2.0 requires `technology/typescript`, so Angular
  evidence takes precedence over generic TypeScript evidence in the same
  workspace.

### Fixed

- The launcher resolves a nested repository instead of its parent's Paved state,
  compares project paths physically, and passes the resolved project to the
  runtime.
- `init` derives a valid project name from any directory name instead of failing
  schema validation.
- Plugin skills ship the `references/` and `examples/` files their bodies link to.

### Compatibility and limitations

- The Core and document API are at `1.0.0` and `paved/v1`; breaking document API
  changes require a new API version.
- No package has been published to npm, and the plugin is not listed in the
  public Codex or Claude Code plugin directories. It installs from this
  repository as a marketplace source.
- Consumers must review generated proposals and configure an explicit verification
  profile and approved Tool bindings. Initialization does not approve or run checks.
- Automatic schema migrations and executable `paved evidence` and `paved tool`
  command families are not implemented.
- Application code changes and review observations remain agent actions recorded
  in the durable workflow. The runtime enforces phase order, required approval,
  governed testing, verification and evidence before completion.
- Runtime upgrades use artifacts carried by a plugin; there is no registry-side
  release channel yet. `paved update` alone never activates a different runtime.
