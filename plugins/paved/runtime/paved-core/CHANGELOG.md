# Changelog

Notable user-facing changes to Paved Core are recorded here. This file describes
releases, not the development sequence used to build them.

## [Unreleased]

## [2.18.0] - 2026-10-30

### Added

- A curated catalog makes existing adapters, workflows and examples easier to discover.
- Feature plans now scale to the change: bounded work can use a concise plan, while
  broad, ambiguous or high-impact work gets deeper planning. Approval, verification,
  evidence and review remain required.

### Fixed

- Verification proposals no longer execute repository commands during generation,
  feature-map generation no longer requires optional product context, and the adapter
  guide links to the correct template.

## [2.17.1] - 2026-10-30

### Fixed

- Markdown previews render fenced Mermaid diagrams with a version-pinned browser bundle,
  Subresource Integrity and strict security settings. The bundle loads only when a
  document contains a Mermaid diagram.

## [2.17.0] - 2026-10-26

### Added

- A linked Git worktree without its own `.paved/` now uses the main worktree's Paved
  state, while tests, verification, source digests, adapter detection and the run diff
  use the linked worktree's files. `status` reports `stateRoot` and `sourceRoot`, and
  `PAVED_WORKTREE_STATE_IN_MAIN` is now an info diagnostic saying shared state is in use;
  `mainWorktree` is no longer reported. A worktree with its own `.paved/` keeps using it.
- Generated context records the linked worktree it came from (`sourceWorktree` in
  `last-run.json`, `contextWorktrees` in `status`), so changes in another worktree are not
  reported as drift.
- Workflow runs record their linked worktree (`worktree`) and resume only from it;
  `--run` from another checkout fails with `PAVED_WORKFLOW_WORKTREE_MISMATCH`.
- The project command `.paved/runtime/bin/paved` works from a linked worktree and keeps
  working on it.

## [2.16.0] - 2026-10-26

### Fixed

- Source drift in generated project context (a cited file changed, or new relevant
  sources appeared) no longer makes the project `STALE`, so `test`, `intent`, `plan` and
  `execute` keep working during development. `status` reports it as
  `generatedContext: drifted`, and a completed run regenerates the context. Lock, Core,
  generator-input and missing-output problems still block work.
- Regenerating generated context is a recoverable `context-regenerating` effect that a
  user can answer in the conversation instead of authoring an approval file.
- The context repair decision keeps its id while more cited files change, so an answer
  is no longer lost when the findings grow; a regeneration or new evidence still asks
  again. A skipped repair no longer fails `status` once its evidence changes.
- The launcher keeps a version-independent project command at
  `.paved/runtime/bin/paved` that works from non-interactive shells and survives plugin
  updates. Remediation and next-action texts print that command, quoted, so they can be
  pasted as is instead of naming a `paved` that may not exist on `PATH`.
- Tests that fail because a service, container engine or program is unavailable are
  reported as `PAVED_TEST_ENVIRONMENT_UNAVAILABLE` and block validation with
  `PAVED_WORKFLOW_ENVIRONMENT_UNAVAILABLE` without spending attempts. Plan approval
  records a test baseline, and a validation failure on tests that already failed carries
  `PAVED_WORKFLOW_BASELINE_FAILING`.
- In a linked Git worktree without Paved state, `status` finds the main worktree's state
  and reports it (`mainWorktree`, `PAVED_WORKTREE_STATE_IN_MAIN`) with how to share it,
  instead of only suggesting a fresh `init`.

## [2.15.2] - 2026-10-25

### Changed

- The frontend-design skill now asks for concrete visual direction on substantial work,
  checks for choices that lack product-specific rationale, guides clear and actionable
  interface copy, and adds an explicit rendered-result critique.

## [2.15.1] - 2026-10-25

### Changed

- The frontend-design skill now evaluates applicable UX principles, including target
  acquisition, familiar conventions, choice complexity, grouping, and accessible target
  size, while treating them as context-sensitive guidance rather than universal laws.

## [2.15.0] - 2026-10-24

### Added

- Optional task-level harness experiments in approved delegation graphs: one baseline
  and up to two isolated candidates, with equivalent scopes and explicit change rationale.
- A reusable harness-refinement procedure that compares quality before reported cost,
  token use and duration, and treats incomplete comparisons as inconclusive.
- A local paired-run analyzer for task-level harness evaluations, with independent-review
  and acceptance-check requirements before recommending an efficiency variant.

## [2.14.0] - 2026-10-24

### Added

- During initialization, create a project-local app verification skill and feature map
  when repository evidence shows a runnable application or CLI; live evidence is still
  required before the guide is marked ready.

## [2.13.0] - 2026-10-24

### Added

- A schema-validated paired delegation evaluation dataset and CLI analyzer for
  reproducible quality, latency, token, cost and retry comparisons.

## [2.12.1] - 2026-10-24

### Fixed

- Preserve shared-workspace scope violations from failed and recovered attempts, and
  require out-of-scope edits to be restored before retrying.

## [2.12.0] - 2026-10-24

### Added

- Human approval bound to the immutable delegation graph, serialized shared-workspace
  writers, host-reported changed-path checks, interrupted-session recovery, and
  host-specific Claude Code/Codex capability guidance.
- A reproducible paired evaluation protocol comparing sequential and delegated task
  quality, token usage, cost and latency.

## [2.11.0] - 2026-10-23

### Added

- Bounded implementation delegation graphs with task dependencies, write-scope and
  concurrency checks, host-native Claude Code/Codex execution guidance, task-level
  model-capacity policy, and host-reported model, effort and usage records.

## [2.10.0] - 2026-10-23

### Changed

- Feature development guidance now helps agents choose model capacity by task difficulty,
  split independent work across isolated sessions when coordination is worthwhile, and
  keep integration, verification and evidence with the primary agent.

## [2.9.0] - 2026-10-13

### Added

- The Flutter adapter now provides cross-platform implementation guidance for shared
  iOS, Android and Web applications, and feature development loads relevant knowledge
  from the selected technology adapter before implementation.

## [2.8.0] - 2026-10-12

### Added

- `paved execute "<request>"` starts work from a single command. It initializes Paved
  when the repository has none, updates it when its state needs `paved update`, records the request and returns the decisions it needs
  answered. `paved execute --run <id>` then drives the run through context, discovery
  and planning as well, and `--approve` records the user's approval of the plan.
  Nothing is implemented before that approval.

## [2.7.0] - 2026-10-12

### Changed

- The review phase needs findings from a reviewer that did not write the change. Paved
  writes a brief for a subagent with its own context, and the subagent records a
  `ChangeReview` with the digests of the plan, source and evidence it read. A review
  that was not isolated, or that read an older state, is refused. Blocking findings go
  to the user: fixing them reopens implementation, so the fix is tested, verified and
  reviewed again; accepting them keeps them on record.

## [2.6.1] - 2026-10-12

### Changed

- The README now explains why Paved exists and how it is built, and ships in the
  plugins.

## [2.6.0] - 2026-10-12

### Added

- A Check can declare `covers`: further check types a pass also proves, for one suite
  that runs several kinds of test. Evidence records the covered types, completion and
  workflow gaps count them, and a result claiming a type its definition does not
  declare is rejected.

### Changed

- `core.testing.run` 0.1.2, `core.testing.results`, `core.testing.smoke` and
  `core.testing.targeted` 0.1.1 allow up to 3600 seconds, so a project binding can run a
  long suite. Set `timeout_seconds` on the binding to keep a shorter limit.
- An email given to `--answered-by` is stored as a stable pseudonym
  (`person-<digest>`), so versioned decision records do not publish the address.

### Fixed

- A run started before the repository's first commit counts every file as changed,
  instead of finding no changed file once the work is committed.
- Approving an amended plan for a run that is past implementation reopens
  implementation, validation, verification, evidence and review, so the amended plan is
  delivered and reviewed again.
- Each evidence recording writes its own files (`<run>-workflow-2.yaml`, ...), and only
  the evidence in force is checked for integrity. Changed evidence names its file and
  how to recover, and `paved plan --amend` is no longer blocked by it.
- `paved gardener` skips an evidence record that contradicts its own observations,
  naming the file and its problems, instead of stopping the whole analysis.

## [2.5.1] - 2026-10-12

### Fixed

- Testing adoption detects explicitly declared npm `test:*` scripts, including unit,
  integration and end-to-end suites, so development workflows can offer them as governed
  testing commands.
- Tool bindings accept `@` in direct executable paths, as used by some version managers.

## [2.5.0] - 2026-10-12

### Added

- `paved tool add <check-type> [label] [--scope <dir>] -- <command...>` writes a Tool,
  its binding and a Check for one explicit command, adds the Check to the verification
  profile and validates the result in the same call.

### Changed

- `core.testing.run` 0.1.1 declares `text` output: the exit code decides, so an
  ordinary test runner can bind to it without emitting JSON. Implementations that emit
  JSON keep working.

### Fixed

- Answering `amend` or `abandon` on an exhausted phase no longer grants an extra round of
  attempts; only `retry` and an approved amendment do.
- Work confirmed as already done before the run reaches completion with an empty change
  diff instead of blocking the evidence phase.

## [2.4.0] - 2026-10-11

### Added

- `paved execute --auto` delivers an approved plan: tests, verification, workflow
  evidence and completion run on their own until a phase needs the user.
- Paved writes the workflow evidence itself, with the change diff, the authoritative
  checks and a gap for each recommended check type that did not run.
- `paved plan --amend` re-submits an edited plan for approval mid-run; approval restarts
  the failed phase.
- `--abandon` cancels a run on `intent`, `plan` and `execute`; the same request can then
  start a new run.
- Verification detection offers pytest, ruff and mypy (through uv, Poetry or the Python
  module), `go test`/`go vet`, `cargo build`/`cargo test` and Gradle `test`.
- `paved status` reports an unresolved Check, Tool or binding before `execute` reaches
  verification.
- Lifecycle blocks that `paved init` or `paved update` resolve name the command in
  `data.remediation`, and agent commands run it before repeating the original command.

### Changed

- A phase that runs out of attempts asks whether to retry, amend the plan or abandon the
  run instead of failing the run for good.
- A setup problem in testing or verification no longer consumes a phase attempt.
- `implementation` asks whether the approved work already exists instead of failing when
  nothing changed since the run started.
- Review asks for approval in the conversation; the preview is optional.
- A passing testing Tool's stderr is a warning, not an error.

### Fixed

- An override may select a project ToolImplementation of an inherited Tool.
- Verification evidence paths resolve through symlinks, so a project under a symlinked
  directory (macOS `/var`) records valid relative paths.

## [2.3.0] - 2026-10-06

### Added

- `paved workbench start` serves a local dashboard of workflow runs, phases, pending
  decisions and recent Claude Code/Codex hook activity. The loopback-only dashboard is
  read-only; hook activity stays in memory and hooks fail open when it is unavailable.

## [2.2.0] - 2026-10-05

### Changed

- Narrowed all skill and command activation descriptions around the user goal and request
  that should trigger them, with explicit distinctions for nearby skills.
- Expanded `context-discovery` activation to include repository orientation and onboarding
  requests that do not ask for a code change.

## [2.1.0] - 2026-10-05

### Changed

- The plugin's prompt hook adds the Paved routing guidance once per session in each
  repository, instead of on every prompt, and again after the context is compacted or
  cleared ([ADR 0037](docs/decisions/0037-session-scoped-prompt-guidance.md)).
- The `plan` step starts from the run's Intent document and links to it.
- A Core release bumps the plugin version by the same kind of bump, and the plugin's
  major version follows the major version of the runtime it bundles. The next release
  ships the plugin as 2.0.0, matching the 2.0.0 runtime it carries since that release.

### Fixed

- `intent` refuses flags it used to ignore: `--because` without `--workflow` or
  `--recommend`, `--input` before the request is classified, an `--input` that would
  replace the request, and `--workflow`, `--recommend`, `--because` or `--part` on an
  existing run.
- Bug discovery reports why the testing Tool could not run instead of asking for a
  regression test.
- An unreadable run document no longer hides the open runs from `status` or breaks run
  selection; it is named with `PAVED_WORKFLOW_RUN_INVALID`.

## [2.0.0] - 2026-10-04

### Breaking

- Every repository change now goes through three steps over one run: `intent`, `plan`
  and `execute` ([ADR 0036](docs/decisions/0036-intent-plan-execute.md)). Agent commands
  go from fifteen to seven:

  | Before | Now |
  |---|---|
  | `feature`, `fix`, `refactor`, `debug` | `intent` |
  | `plan` (alias of `feature`) | `intent`, then `plan` |
  | `implement`, `review` | `execute` |
  | `test`, `verify` | run inside the steps; CLI subcommands only |
  | `doctor` | `status`; CLI subcommand kept |
  | `gardener` | listed by `execute`; CLI subcommand kept |
  | `init`, `status`, `preview`, `update` | unchanged |

  The `paved feature`, `paved fix`, `paved refactor`, `paved debug`, `paved implement` and
  `paved review` CLI subcommands are removed too.
- The `performance`, `incident` and `release` workflows are removed. Overrides that target
  them fail with `PAVED_OVERRIDE_TARGET_MISSING`. Run performance work as a `refactor` or a
  `feature`.
- `status` shows the diagnostics and repair decisions that `doctor` showed, lists open runs,
  and changes state only when the user answers a repair decision.
- `--approve` is accepted only by `plan`.
- These removals skip the usual deprecation release. See
  [migrating to 2.0](docs/getting-started/migrating-to-2.md).
- A project manifest written by 1.x pins `paved.core` to a 1.x range; change it to `^2.0.0`
  before `update`, which otherwise refuses the new Core with `PAVED_MANIFEST_CORE_INCOMPATIBLE`.

### Added

- `intent` classifies a request as `feature`, `bug` or `refactor` with evidence
  (`--workflow --because`), asks the user when it is uncertain (`--recommend`), and proposes
  a split of a mixed request (`--part`). A step outside its phases names the step to run,
  and with several open runs Paved asks which one.
- Runs record how their workflow was chosen in a `classification` field.
- Each step's result names the documents to review in the preview. `execute` writes a
  review record to `.paved/generated/reviews/<run>.md`, including evidence gaps.
- `execute` lists gardener proposals not reported before when a run completes; they never
  block completion.
- `paved agent update` deletes Paved-generated command and skill files of removed commands.
  Files without the Paved header are left alone.
- `update` rewrites the managed Paved block in `AGENTS.md`, and `status` reports an outdated
  block (`PAVED_AGENTS_BLOCK_OUTDATED`).

### Changed

- Each workflow's gate logic lives in its own handler module, and a test requires every
  gate of every Core workflow to have one.
- The bundled adapters declare compatibility with Core 1 and Core 2 (`^1.0.0 || ^2.0.0`).

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
