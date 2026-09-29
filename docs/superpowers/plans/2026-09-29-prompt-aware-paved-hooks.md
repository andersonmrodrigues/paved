# Prompt-Aware Paved Plugin Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trusted Codex and Claude Code `UserPromptSubmit` hook that routes relevant prompts toward Paved in initialized consumer repositories.

**Architecture:** Implement one dependency-free Node.js handler under `integrations/shared/`, and have the plugin generator package it with a shared `hooks/hooks.json` discovered at the default plugin path by both hosts. The handler reads JSON stdin and filesystem markers, fails open, and emits `hookSpecificOutput.additionalContext`; the existing Paved runtime remains responsible for all commands and gates.

**Tech Stack:** TypeScript build pipeline, Node.js 22 built-ins, host plugin hook manifests, Node test runner, Markdown documentation.

**Spec:** `docs/superpowers/specs/2026-09-29-prompt-aware-paved-hooks-design.md`

## Global Constraints

- “The hook is advisory and must fail open: malformed input, missing fields, missing project state, or an internal exception produces no injected context and must not block the user's message.”
- “No prompt text is persisted, transmitted, or logged by the hook.”
- “Do not create or overwrite `CLAUDE.md`, `.claude/settings.json`, or project hook files.”
- “This release does not add a Claude-specific instruction-file fallback: per-prompt routing in Claude Code depends on the plugin hook being enabled and trusted.”
- “The hook does not choose a workflow or run commands. The agent uses existing skill and command contracts; the runtime determines availability and applies its gates.”
- “For requests unrelated to the repository, proceed normally without invoking Paved.”
- “Respect explicit user direction. If a required Paved command is unavailable, explain the blocker rather than silently substituting an undeclared process.”

## Review Focus

- `cwd` inside a nested directory must resolve the nearest repository boundary; pin with nested-repository test in Task 1.
- A nested `.git` worktree marker may be a file rather than a directory; test file marker support in Task 1.
- Partial Paved state (manifest without lock, or lock without manifest) must not inject context; test both cases in Task 1.
- Hook JSON may be valid but have wrong field types or no `cwd`; test malformed and incomplete payloads in Task 1.
- The default plugin hook path must remain discoverable without manifest overrides; assert both host manifests preserve their existing metadata in Task 2.

## File Map

- Create `integrations/shared/prompt-submit-hook.mjs`: stdin parsing, boundary lookup, Paved-state check, fail-open output.
- Create `integrations/shared/hooks.json`: shared UserPromptSubmit registration for Codex and Claude Code using the plugin root.
- Modify `plugins/build.ts`: package handler and hook manifest; include files in provenance as with all generated files.
- Create `tests/integrations/prompt-submit-hook.test.ts`: subprocess tests against temporary repository layouts and hook output.
- Modify `tests/plugins/package.test.ts`: assert both host manifests refer to the packaged hook and generated provenance covers it.
- Modify `docs/getting-started/installing-the-plugin.md`: document hook behavior, review/trust activation, and limitations.
- Modify `docs/concepts/agent-integration.md`: document prompt routing as an advisory plugin integration.
- Create `docs/decisions/0031-prompt-aware-plugin-hooks.md` and update `docs/decisions/README.md`: record contract and amend ADR 0024's integration model.
- Modify `CHANGELOG.md`; `release.sh` updates `plugins/plugin-source.json`, `VERSION`, `manifest.yaml`, `package.json`, and `package-lock.json` together.
- Regenerate `plugins/paved/` with `npm run build:plugin`.

## Tasks

### Task 1: Implement and test the prompt hook handler

**Files:**
- Create: `integrations/shared/prompt-submit-hook.mjs`
- Test: `tests/integrations/prompt-submit-hook.test.ts`

**Interfaces:**
- Consumes one JSON object from stdin with optional `cwd: string`.
- `cwd` walks upward to the first directory containing `.paved/manifest.yaml` or `.git`; injects only when that same directory contains both `.paved/manifest.yaml` and `.paved/paved.lock`.
- Produces one JSON line `{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "..." } }` for initialized consumers; all other inputs exit 0 with no stdout/stderr.
- The context contains the four routing rules from the spec and does not include prompt text or filesystem content.

- [ ] **Step 1: Write failing subprocess tests**

Create helpers that run `process.execPath` on the handler with JSON stdin and a temporary directory. Assert guidance for a complete Paved root; no output for unrelated directories, missing manifest, missing lock, absent/non-string cwd, invalid JSON, and non-object input. Assert nested paths resolve upward, nested `.git` boundaries stop parent Paved discovery, and `.git` works as either file or directory. Assert every result exits zero and emits no stderr.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/integrations/prompt-submit-hook.test.ts`
Expected: FAIL because the handler file does not exist.

- [ ] **Step 3: Implement the minimal handler**

Use only `node:fs` and `node:path`. Parse stdin inside a top-level try/catch, validate `cwd`, inspect ancestors without executing shell commands, recognize `.git` with `existsSync` regardless of file/directory type, then check both state files. Write only the `additionalContext` JSON line when state is complete. Catch all errors and exit successfully without writing diagnostics.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/integrations/prompt-submit-hook.test.ts`
Expected: PASS for initialized, boundary, partial-state, malformed-input, and fail-open cases.

- [ ] **Step 5: Commit the handler and tests**

```bash
git add integrations/shared/prompt-submit-hook.mjs tests/integrations/prompt-submit-hook.test.ts
git commit -m "feat: add prompt-aware Paved routing hook"
```

### Task 2: Package the shared hook for both plugin hosts

**Files:**
- Create: `integrations/shared/hooks.json`
- Modify: `plugins/build.ts`
- Test: `tests/plugins/package.test.ts`

**Interfaces:**
- `hooks.json` registers `UserPromptSubmit` for Codex and Claude Code and invokes `hooks/paved-prompt-submit.mjs` with Node using `CLAUDE_PLUGIN_ROOT` (also supplied by Codex for compatibility).
- Both hosts discover the default `hooks/hooks.json` path; generated manifests retain current skills and interface settings.
- `planPlugin()` includes `hooks/hooks.json` and `hooks/paved-prompt-submit.mjs`; the normal provenance digest covers both.

- [ ] **Step 1: Add failing generated-package assertions**

Extend `tests/plugins/package.test.ts` to parse each host manifest, assert there is no conflicting hook override, read the generated hook manifest and assert the `UserPromptSubmit` handler uses the plugin-root path, verify the handler bytes match the shared source, and verify both paths appear in provenance. Keep existing manifest fields asserted.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test tests/plugins/package.test.ts`
Expected: FAIL because generated plugin does not contain hook files or discovery metadata.

- [ ] **Step 3: Implement packaging and manifest discovery**

Add shared source files to `planPlugin()` and adjust `manifests()` in `plugins/build.ts` only if explicit hook paths are required. Codex and Claude Code discover the default `hooks/hooks.json` path, so preserve identity and existing host-specific fields. Use the official host conventions linked in the spec; do not add runtime dependencies.

- [ ] **Step 4: Build and run packaging tests**

Run: `npm run build:plugin && node --test tests/plugins/package.test.ts`
Expected: plugin regeneration succeeds; package, provenance, marketplace, and existing generated-file checks pass.

- [ ] **Step 5: Commit package changes**

```bash
git add integrations/shared/hooks.json plugins/build.ts plugins/paved tests/plugins/package.test.ts
git commit -m "build: package prompt hooks for Codex and Claude"
```

### Task 3: Document behavior, trust, and architecture

**Files:**
- Modify: `docs/getting-started/installing-the-plugin.md`
- Modify: `docs/concepts/agent-integration.md`
- Create: `docs/decisions/0031-prompt-aware-plugin-hooks.md`
- Modify: `docs/decisions/README.md`
- Modify: `docs/superpowers/specs/2026-09-29-prompt-aware-paved-hooks-design.md`

**Interfaces:**
- User documentation explains the hook is advisory, only active in initialized repositories, and depends on host trust/review.
- ADR 0031 updates the project-local projection decision with plugin-owned per-prompt routing and preserves the AGENTS.md fallback contract.

- [ ] **Step 1: Add doc assertions where documentation tests exist**

Inspect `tests/docs/agent-integration.test.ts` and extend it to assert the install guide and concept docs cover hook review/trust, initialized-state scope, and advisory behavior. Add an assertion that no instructions tell users to create `CLAUDE.md` or project hook files.

- [ ] **Step 2: Run documentation tests and confirm failure**

Run: `node --test tests/docs/agent-integration.test.ts`
Expected: FAIL on the missing hook guidance.

- [ ] **Step 3: Write installation guidance and concept documentation**

Describe what happens on each prompt, the next-prompt behavior after initialization, how to review/enable trusted hooks in both hosts, how to disable or remove through native plugin controls, and that hook inactivity leaves existing Paved skill commands and AGENTS.md behavior available where the host loads it.

- [ ] **Step 4: Record the decision and close the spec**

Add ADR 0031 with accepted status, context, decision, consequences, references, and explicit trust/failure behavior. Add it to the decisions index. Update ADR 0024 to point to the new decision and clarify that global plugin prompt hooks complement its project-local skill projections. Mark the spec's direction as accepted and remove the sentence saying an ADR will be added.

- [ ] **Step 5: Run documentation tests**

Run: `node --test tests/docs/agent-integration.test.ts`
Expected: PASS and all links referenced by the docs resolve.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/getting-started/installing-the-plugin.md docs/concepts/agent-integration.md docs/decisions docs/superpowers/specs/2026-09-29-prompt-aware-paved-hooks-design.md tests/docs/agent-integration.test.ts
git commit -m "docs: explain prompt-aware plugin hooks"
```

### Task 4: Version and release the feature

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `plugins/plugin-source.json`, `VERSION`, `manifest.yaml`, `package.json`, and `package-lock.json` through `release.sh`
- Regenerate: `plugins/paved/`

**Interfaces:**
- Core version advances one compatible minor release from current `1.7.0` to `1.8.0`; plugin version advances because packaged contents changed.
- `release.sh` runs the required plugin build and Core check, commits/pushes the release commit on `main`; tag `v1.8.0` and push it after successful release.

- [ ] **Step 1: Add an Unreleased changelog entry and bump plugin source version**

Add a feature entry describing prompt-aware routing for trusted Codex and Claude plugins. `release.sh minor` updates Core and plugin versions together and regenerates all three host manifests.

- [ ] **Step 2: Build plugin and verify package drift**

Run: `npm run build:plugin && npm run check:plugin`
Expected: build succeeds and check reports empty drift and conflicts.

- [ ] **Step 3: Run required full check**

Run: `npm run check`
Expected: strict typecheck and all tests pass, including hook, docs, package, and provenance checks.

- [ ] **Step 4: Review version and release script inputs**

Run: `git status --short && git diff --check && sed -n '1,240p' release.sh`
Expected: only intended files changed; release script targets the documented minor bump and requires `main` with a clean tree after commit.

- [ ] **Step 5: Commit feature and prepare release on main**

Integrate the verified implementation branch into `main`, preserving the approved spec commit. Update `[Unreleased]` to `1.8.0` as `release.sh` requires. Ensure `main` is current with its remote before running the script.

- [ ] **Step 6: Run the authorized release**

Run: `./release.sh minor`
Expected: script passes its build/check gates, creates and pushes the `1.8.0` release commit to `main`.

- [ ] **Step 7: Tag and verify the release**

Run: `git tag -a v1.8.0 -m "Paved Core v1.8.0" && git push origin v1.8.0 && git status --short --branch`
Expected: tag is pushed and the working tree is clean and synchronized.

## Self-Review

- Spec coverage: handler behavior and state checks (Task 1); shared packaging and provenance (Task 2); trust/fallback docs and ADR (Task 3); full checks and tagged release (Task 4).
- No placeholders: each task names concrete files, commands, behavior, and expected result.
- Type/interface consistency: generated names are `hooks/hooks.json` and `hooks/paved-prompt-submit.mjs`; shared inputs are `integrations/shared/hooks.json` and `integrations/shared/prompt-submit-hook.mjs`.
- Review Focus conditions are covered in Task 1 or Task 2.
- User authorized push and release; no remote action occurs before all local verification and the release script's own gates pass.
