# Changelog

Notable user-facing changes to Paved Core are recorded here. This file describes
releases, not the development sequence used to build them.

## [Unreleased]

## [1.16.1] - 2026-10-02

### Changed

- Reworded the remediation for missing workflow evidence, which Claude's directory
  scan mistook for a credential read.

## [1.16.0] - 2026-10-02

### Changed

- Claude Code installs the plugin from `plugins/claude/paved/`. That copy ships the
  runtime without `node_modules/`, and its `package-lock.json` pins the runtime's
  dependencies. Claude Code installs them, and the launcher checks them with the
  runtime against the same integrity. The plugin now stays within Claude's plugin
  directory limits. Codex and Cursor keep installing `plugins/paved/`
  ([ADR 0035](docs/decisions/0035-host-specific-plugin-directories.md)).
- The plugin launcher moved from `bin/paved.mjs` to `scripts/paved.mjs`.
- The Codex plugin has OpenAI's listing fields: a short description, a logo and a
  composer icon. `npm run package:openai` builds the ZIP for OpenAI's plugin
  directory, without the prompt hook.

## [1.15.3] - 2026-10-02

## [1.15.2] - 2026-10-01

### Added

- The plugin ships a listing icon for Claude's plugin directory.

### Changed

- The plugin ships its `paved-core` runtime unpacked under `runtime/paved-core/`
  instead of as a tarball, so plugin directories can review every file. The launcher
  copies it into `.paved/runtime/` and verifies the copy against a SHA-512 over its
  file digests, without running npm. Projects pinned to an earlier runtime see the
  usual update notice and adopt it with `update`.

## [1.15.1] - 2026-09-30

### Changed

- The preview's document uses the full width between the document list and the
  comments instead of a narrow centered column.

## [1.15.0] - 2026-09-30

### Added

- `paved preview` reviews a folder: every Markdown file in it, with navigation between
  documents and comments on any of them in one review and one `wait` loop.
- Comments show whether the agent received them, is working on them or resolved them;
  `paved preview working` and `paved preview resolve --reply` report it, and the reply
  appears in the browser. When the agent is not watching, the page copies a prompt with
  the pending comments for any agent's terminal.
- `--approve` on executable workflows records the user's conversational approval for
  the current plan digest and resumes the run.

### Changed

- The preview approves nothing and no longer takes `--run`: approvals and
  confirmations are asked in the conversation. `task-specification` and `task-review`
  0.4.0 ask before writing to the tracker and put split tasks in a folder preview.

## [1.14.0] - 2026-09-30

### Changed

- `task-specification` and `task-review` 0.3.0 present every draft and review in
  `paved preview` instead of printing it in the chat: the reply carries the URL and a
  short summary, and the preview's approval is the confirmation to write to the tracker.
  The chat is a fallback only when the user asks or the preview cannot start.

## [1.13.0] - 2026-09-30

### Changed

- `task-specification` 0.2.0 also fills in an existing issue or ticket, including one
  given by link, keeping what its author wrote. Both task skills now use the
  repository's own issue template when there is one (a project addendum still wins),
  offer options instead of guessing when the repository allows several readings, never
  add unsupported content, and may open long drafts in `paved preview`, where approval
  is the confirmation to write to the tracker. The quality bar adds splitting patterns,
  failure-case criteria and a ready-to-implement check.
- The prompt hook routes writing, filling in and reviewing tasks and issues to
  `paved:task-specification` and `paved:task-review`.

## [1.12.0] - 2026-09-30

### Changed

- `paved update` adopts a newer runtime carried by the plugin: it verifies and activates
  it, rewrites `.paved/paved.lock` through the transactional update and keeps the
  previous state for `runtime rollback`. `update --dry-run` reports the runtime it would
  adopt; the same or an older plugin runtime never changes the pin
  ([ADR 0032](docs/decisions/0032-update-adopts-newer-plugin-runtime.md)).

### Fixed

- A runtime upgrade is no longer blocked by the rollback record of the previous
  successful upgrade, so consecutive upgrades work.
- A runtime upgrade works in a fresh clone, where `.paved/runtime/` does not exist yet.
- `paved update` accepts a Core minor within the same stable major (for example 1.10 to
  1.11), as the versioning policy promises; it had applied the `0.x` rule and refused
  every minor. Moving to an older minor or another major still needs a migration.

## [1.11.0] - 2026-09-30

### Added

- A `product` skill category with `task-specification` 0.1.0, which turns a request
  into tracker-ready tasks grounded in the repository (type, description, expected
  result, verifiable acceptance criteria, technical context, steps to reproduce) and
  splits requests too large for one task, and `task-review` 0.1.0, which reviews an
  existing task against the same template and the repository and returns validated
  findings, a verdict and a corrected version. Both write to a tracker only after the
  user confirms the exact text; projects customize the template by extending
  `core.product.task-specification` with an addendum.

### Fixed

- The Markdown preview approves a plan with a single Approve button: it no longer asks
  for the approver's name (the local user running the preview is recorded) and no longer
  fails with "Workflow approval request does not match this version of the plan" when
  the plan is approved before the workflow requests approval for that exact version.
- Preview comments no longer appear to go nowhere: `paved preview wait` records that the
  agent is watching, the page shows whether the agent is following the review and tells
  the reviewer to ask in chat when it is not, and every `wait` result carries a
  `next_action` (a timeout says to wait again instead of ending the turn).

## [1.10.0] - 2026-09-30

### Changed

- `change-review` 0.4.0 reviews against the stated intent in three passes (rules,
  diff, change), separates blocking findings from notes, discards pre-existing,
  tool-caught, silenced and speculative candidates, and validates every blocking
  finding against the code before recording it. Rule findings must quote the rule and
  fall within its scope.
- `security-review` 0.4.0 requires a traced source-to-sink path for every finding and
  keeps untraced hardening ideas as notes.

## [1.9.0] - 2026-09-29

## [1.8.0] - 2026-09-29

### Added

- A shared Codex and Claude Code prompt hook keeps Paved routing guidance available
  on each user turn in initialized repositories. Hook activation follows host trust
  controls and fails open without running Paved commands.

## [1.7.0] - 2026-09-29

### Added

- A Core `frontend-design` skill for frontend changes, activated in feature and bug
  planning/implementation when the interface is affected.

## [1.6.0] - 2026-09-29

### Added

- A versioned `.paved/documents/` workspace for workflow intents, plans, specs, tasks,
  and research. Init scaffolds the document guide; planning commands use the canonical
  plan path for Markdown preview and hash-bound approval.

## [1.5.0] - 2026-09-29

### Added

- Local Markdown preview for plans and specs with selected-text comments, a shared
  Codex/Claude review loop, and browser approval bound to the exact document hash.
  Workflow plans can request approval again after review edits in the same run.

## [1.4.2] - 2026-09-29

### Fixed

- When a runtime update replaces a decision question, init supersedes the old
  pending answer options and presents the current choice instead of leaving a
  stale single-command testing decision in status.

## [1.4.1] - 2026-09-29

### Fixed

- In monorepos, init can adopt every detected module test command and `paved test`
  executes all of them, reporting a failure from any module with per-command evidence.
  Local Maven dependencies run first and install their artifact before consumers test;
  newly adopted verification checks use the same order and lifecycle.

## [1.4.0] - 2026-09-29

### Added

- `paved init` asks which detected test command development workflows run, so
  `feature`, `fix`, `refactor`, `implement` and `test` are available right after init.
- `paved init` writes the managed Paved block to `AGENTS.md` as its layout contract
  declares: it creates the file, appends the block or refreshes only the block, and
  never changes other text. The block no longer cites a nonexistent Core cache path.

### Fixed

- Checks and the testing Tool now inherit the user's toolchain selectors (`JAVA_HOME`,
  `MAVEN_HOME`, `HOME` and similar) and always run with `CI=true`; Maven no longer
  falls back to the newest installed JDK.
- Detected Angular `ng test` checks run once (`--watch=false`, headless Chrome for Karma)
  instead of watching until the timeout, and `ng test` is not offered for a project
  with no spec files. Generated check timeouts are 900 seconds.
- Generators also withhold drafts while the corresponding decision is still open, so
  init never reports proposals for questions it is already asking.

## [1.3.0] - 2026-09-29

### Fixed

- `paved init` asks about every build-enforced Checkstyle module in the same rules
  question instead of leaving per-module rule proposals for manual YAML review, and no
  longer mistakes `checkstyle-suppressions.xml` for the Checkstyle configuration.
- Generators withhold (and remove stale) rule and verification proposals once the
  matching project document exists or the user answered the corresponding decision.
- The release changelog step ships `[Unreleased]` entries under the version being
  released.

## [1.2.0] - 2026-09-29

### Added

- A canonical decision interaction skill that tells agents how to present, relay and
  resume conversational decisions without taking authorship from the user.
- Shared Codex and Claude Code command projections now declare interaction mode,
  decision source and answer channel, and render the same concise answer/resume contract.

### Changed

- `paved update` applies only explicitly registered, deterministic migrations to
  legacy documents in its staged transaction; unknown or ambiguous document versions
  remain blocked.

## [1.1.0] - 2026-09-28

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
