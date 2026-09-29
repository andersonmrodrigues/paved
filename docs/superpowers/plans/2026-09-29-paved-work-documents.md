# Paved Work Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consumer repositories a durable, versioned `.paved/documents/` home and have Paved workflows consistently use it.

**Architecture:** Declare `.paved/documents/` as optional committed `project-owned` content in the Core consumer layout. Workflow guidance will define category paths and preview usage; the workflow engine will retain compatibility with existing arbitrary plan references while the Paved agent creates new plans at the canonical path. Init creates a lightweight scaffold without requiring it for READY.

**Tech Stack:** TypeScript on Node.js 22, YAML manifest contracts, `node:test`, generated plugin projection.

**Spec:** `docs/superpowers/specs/2026-09-29-paved-work-documents-design.md`

## Global Constraints

- Core remains domain- and technology-agnostic.
- Consumer document storage is optional for READY and committed with project changes.
- Workflow state and local evidence remain disposable under `.paved/generated/`.
- Existing runs whose plan references are outside `.paved/documents/plans/` remain resumable.
- All schema contracts remain covered by tests; full gate is `npm run check`.

## Review Focus

- Existing run references may point outside the new tree; retain current resume behavior and pin with workflow tests.
- Init may run over a partially populated `.paved/`; scaffold creation must not overwrite existing user files.
- A symlink at `.paved/documents/` could redirect scaffold writes outside the repository; init must reject that path.
- A repository without `.paved/documents/` must still report READY; pin in status/layout tests.
- Preview approval must hash the same canonical plan file the workflow run references; pin with preview/workflow tests.
- Generated plugin instructions must match Core source; rebuild and run plugin drift checks.

---

### Task 1: Consumer layout contract and docs

**Files:**
- Modify: `manifest.yaml`
- Modify: `docs/concepts/ownership-and-regeneration.md`
- Modify: `docs/concepts/multi-repository.md`
- Test: `tests/core/manifest.test.ts`

**Interfaces:** Adds the `.paved/documents/` optional, committed `project-owned` layout entry; no schema or ownership enum changes.

- [x] Add a manifest test asserting path, ownership, required=false, committed=true.
- [x] Run `node --experimental-strip-types --test tests/core/manifest.test.ts` and confirm failure.
- [x] Add the layout entry and explain durable work docs vs disposable run/evidence files.
- [x] Rerun the focused test.

### Task 2: Init scaffold, optional health, and workflow plan location

**Files:**
- Modify: `cli/lib/generator-runtime.ts`
- Modify: `cli/commands/workflow.ts` only if a code change is required to support canonical refs without rejecting legacy refs
- Test: `tests/package/bootstrap.test.ts`
- Test: `tests/workflows/execution.test.ts`

**Interfaces:** Init creates `.paved/documents/README.md` only when absent. It documents categories and does not create empty tracked directories. New workflow agents use `.paved/documents/plans/<run-id>.md`; CLI resume continues honoring its persisted event reference.

- [x] Add tests for scaffold content, no overwrite on re-init, and READY without documents.
- [x] Run focused tests and confirm failures.
- [x] Implement idempotent scaffold creation; keep the path optional in health checks.
- [x] Add symlink traversal regression test; init rejects a symlinked documents directory.
- [x] Existing workflow execution tests use outside-path plan references and passed unchanged, preserving resume compatibility.
- [x] Run focused tests.

### Task 3: Agent workflow instructions and preview integration

**Files:**
- Modify: `core/instructions/workflows.md`
- Modify: relevant `core/skills/{plan,feature,fix,refactor}/SKILL.md`
- Test: `tests/agent-contract/synthetic-agent.test.ts`
- Test: `tests/workflows/workflows.test.ts`

**Interfaces:** Instructions define `intents/`, `plans/`, `specs/`, `tasks/`, and `research/` using `<run-id>.md`, only creating documents that are useful for the task. Planning and approval use the plan path in `documents/plans`; preview opens that exact file and resolves comments before approval.

- [x] Add instruction assertions for category paths, run id, and preview canonical path.
- [x] Run focused tests and confirm failure.
- [x] Update canonical instructions and skill sources; bump modified skill contracts.
- [x] Build the plugin projection and run focused tests.

### Task 4: Version, changelog, plugin projection, full verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `VERSION`, `manifest.yaml`, `package.json`, `plugins/plugin-source.json` only if required by the repository's current unreleased versioning state
- Generated: `plugins/paved/`

- [x] Record the new consumer layout/workflow behavior under `[Unreleased]`.
- [x] Run `npm run build:plugin`.
- [x] Run `npm run check`: typecheck passed; all 817 tests passed.
- [x] Review the diff for unintended changes, especially the pre-existing Markdown preview work.
