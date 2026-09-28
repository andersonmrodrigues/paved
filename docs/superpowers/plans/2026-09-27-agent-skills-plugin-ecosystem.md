# Agent Skills and Plugin Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, deterministic Codex and Claude Code projections for Paved's existing agent-neutral contracts without moving agent behavior into Core.

**Architecture:** Add a versioned integration package contract and a shared projection engine under `integrations/`. The CLI `agent` command delegates to that engine for list, status, install, update, uninstall and validate operations. Projections contain canonical skill metadata and thin instructions that invoke the existing JSON CLI; `.paved/` remains the source of truth.

**Tech Stack:** TypeScript 7, Node 22, YAML, JSON Schema draft 2020-12, Node test runner, existing atomic-write/lock/provenance helpers.

---

## File map

- `schemas/agent-integration.schema.yaml`: machine-readable package metadata contract.
- `integrations/README.md`: boundary and authoring rules.
- `integrations/shared/`: package types, canonical skill discovery, deterministic projection, compatibility and safe filesystem helpers.
- `integrations/codex/`: Codex adapter metadata and projection layout.
- `integrations/claude-code/`: Claude Code plugin metadata and projection layout.
- `cli/commands/agent.ts`, `cli/runtime.ts`: CLI orchestration only.
- `tests/integrations/*.test.ts`: package, projection, compatibility, safety and idempotency tests.
- `tests/cli/agent.test.ts`: black-box command tests.
- `docs/concepts/agent-integrations.md`, `README.md`, `CHANGELOG.md`, `VERSION`, `manifest.yaml`: public documentation and release metadata.

### Task 1: Add the integration package contract

**Files:**
- Create: `schemas/agent-integration.schema.yaml`
- Create: `integrations/README.md`
- Modify: `manifest.yaml`
- Test: `tests/schemas/agent-integration.test.ts`

- [ ] **Step 1: Write failing schema tests** for valid Codex and Claude metadata, missing target agent, unsupported API version, and extra properties.
- [ ] **Step 2: Run `node --test tests/schemas/agent-integration.test.ts`** and confirm the new schema is missing.
- [ ] **Step 3: Define `AgentIntegration`** with `apiVersion`, `kind`, `id`, `version`, `target`, `supported_paved_api_versions`, `supported_core_range`, `capabilities`, `scope`, and `provenance`; reject unknown properties.
- [ ] **Step 4: Register the schema** in the Core manifest and document that it is package metadata, not Core runtime behavior.
- [ ] **Step 5: Run the focused schema test and `npm run typecheck`.**
- [ ] **Step 6: Commit** `feat: define agent integration package contract`.

### Task 2: Build the shared projection and ownership runtime

**Files:**
- Create: `integrations/shared/types.ts`
- Create: `integrations/shared/catalog.ts`
- Create: `integrations/shared/projection.ts`
- Create: `integrations/shared/safe-files.ts`
- Create: `integrations/shared/compatibility.ts`
- Test: `tests/integrations/projection.test.ts`
- Test: `tests/integrations/safety.test.ts`

- [ ] **Step 1: Write failing unit tests** for canonical skill selection, deterministic output, stable metadata, root containment, symlink rejection, user-owned conflict refusal, and repeated install convergence.
- [ ] **Step 2: Run the focused tests** and confirm the shared modules are absent.
- [ ] **Step 3: Implement typed package and projection interfaces**; adapters return only metadata, destination roots and native manifest rendering.
- [ ] **Step 4: Discover canonical skills** from `core/skills`, read only `SKILL.md` and `skill.yaml`, and preserve the canonical body rather than inventing a second procedure.
- [ ] **Step 5: Render generated files** with a provenance header, canonical skill id/version, documented `.paved/` context paths, and `paved ... --json` invocation guidance; never emit shell code blocks or copy `.paved/`.
- [ ] **Step 6: Implement safe writes** using resolved project-root containment, `lstat` symlink checks, content digests, atomic writes and conflict diagnostics; expose plan/apply/remove operations without deleting unowned files.
- [ ] **Step 7: Implement compatibility checks** against Core `apiVersion`, package range and project manifest/lock metadata; return existing diagnostic categories.
- [ ] **Step 8: Run projection and safety tests, `npm run typecheck`, and commit** `feat: add safe agent projection runtime`.

### Task 3: Add Codex and Claude adapters

**Files:**
- Create: `integrations/codex/index.ts`
- Create: `integrations/codex/package.json`
- Create: `integrations/claude-code/index.ts`
- Create: `integrations/claude-code/package.json`
- Test: `tests/integrations/cross-agent.test.ts`

- [ ] **Step 1: Write failing adapter tests** asserting both adapters expose the same capability set and canonical skill ids/versions.
- [ ] **Step 2: Implement Codex metadata** for repository `.agents/skills/<skill>/SKILL.md` projections and current `agents/openai.yaml` optional metadata only where supported.
- [ ] **Step 3: Implement Claude metadata** for `.claude-plugin/plugin.json` plus `skills/<skill>/SKILL.md`, without hooks, MCP servers or executable commands.
- [ ] **Step 4: Ensure adapter differences are limited** to destination paths and native metadata; use the shared renderer for all semantics.
- [ ] **Step 5: Run cross-agent tests and commit** `feat: add codex and claude agent adapters`.

### Task 4: Add the `paved agent` CLI family

**Files:**
- Create: `cli/commands/agent.ts`
- Modify: `cli/runtime.ts`
- Test: `tests/cli/agent.test.ts`
- Modify: `cli/README.md`

- [ ] **Step 1: Write black-box failing tests** for `agent list`, `agent status`, `agent validate`, `agent install`, `agent update`, and `agent uninstall`, including JSON output and exit-code mapping.
- [ ] **Step 2: Extend parser types** with an `agent` command and selectors `list|status|validate|install|update|uninstall` plus integration id, rejecting unsupported flags.
- [ ] **Step 3: Keep `cli/commands/agent.ts` orchestration-only**: resolve project paths, select adapter, invoke shared plan/apply/remove functions, and convert diagnostics to `CommandResult`.
- [ ] **Step 4: Make install/update idempotent and transactional**; validate before writes, refuse conflicts, and report unchanged state on repeated operations.
- [ ] **Step 5: Run focused CLI tests and commit** `feat: expose agent integration lifecycle`.

### Task 5: Add synthetic-agent and architecture regression coverage

**Files:**
- Create: `tests/agent-contract/integration-agent.test.ts`
- Modify: `tests/core/boundaries.test.ts`
- Modify: `tests/README.md`

- [ ] **Step 1: Write failing synthetic-agent tests** that invoke only the CLI and generated public files to discover metadata, skills, workflows, context, status, diagnostics and verification guidance.
- [ ] **Step 2: Add boundary assertions** that `core/` contains no Codex/Claude/plugin filesystem concepts and integrations do not import private CLI implementation modules.
- [ ] **Step 3: Add lifecycle tests** for install/update/uninstall, manual edits, incompatible metadata, failed writes and source preservation.
- [ ] **Step 4: Run integration tests plus existing CLI/lifecycle/boundary suites.**
- [ ] **Step 5: Commit** `test: enforce agent integration contract and boundaries`.

### Task 6: Document installation, compatibility and security

**Files:**
- Create: `docs/concepts/agent-integrations.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `VERSION`
- Modify: `manifest.yaml`
- Create: `docs/decisions/0024-agent-integration-projections.md`

- [ ] **Step 1: Document the Core → canonical skill → adapter → agent-native projection boundary**, supported commands, project-local scope, generated ownership and limitations.
- [ ] **Step 2: Document current Codex and Claude formats** with links to the official formats verified during implementation; do not claim marketplace or global installation.
- [ ] **Step 3: Document compatibility tuple, diagnostics, conflict behavior, security controls and extension guidance.**
- [ ] **Step 4: Apply the smallest version/changelog update required by existing versioning rules.**
- [ ] **Step 5: Run documentation contract tests, `git diff --check`, and commit** `docs: document agent integrations`.

### Task 7: Full validation and final report

**Files:**
- Modify: `docs/audits/phase-16-final-validation.md`

- [ ] **Step 1: Run `npm run check` twice** and record exact typecheck/test totals.
- [ ] **Step 2: Run clean temporary-consumer install, status, validate, update, uninstall and source-preservation checks** for both adapters.
- [ ] **Step 3: Scan for agent-specific concepts in `core/` and private imports in `integrations/`.**
- [ ] **Step 4: Record passing, deferred and intentionally unsupported criteria** without claiming marketplace distribution or global installation.
- [ ] **Step 5: Run `git diff --check`, `git status --short`, and commit** `docs: validate phase 16 integrations`.
