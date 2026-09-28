# Agent Integration Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate Phase 15 and establish a versioned, agent-neutral contract over Paved's existing CLI and consumer lifecycle.

**Architecture:** Keep the CLI as the sole black-box integration boundary. Document `paved/agent/v1` as a projection of existing manifest, lock, content, lifecycle, result, diagnostic, and exit-code contracts; do not add agent-specific branches or a duplicate runtime API. Add synthetic-agent tests that spawn the CLI and consume JSON only.

**Tech Stack:** Node.js 22+, TypeScript, Node test runner, YAML fixtures, existing Paved CLI.

---

### Task 1: Capture the public Agent Integration Contract

**Files:**
- Create: `docs/concepts/agent-integration.md`
- Modify: `README.md`
- Modify: `docs/concepts/README.md` (if present)
- Test: `tests/docs/agent-integration.test.ts`

- [ ] **Step 1: Write the failing documentation contract test**

Assert that the contract document declares `paved/agent/v1`, public discovery paths, all required capability names, lifecycle states, exit-code mapping, and an explicit public/internal boundary.

- [ ] **Step 2: Run the focused test**

Run: `node --test tests/docs/agent-integration.test.ts`
Expected: FAIL because the contract document and link do not yet exist.

- [ ] **Step 3: Write the contract**

Document discovery, context, skills, workflows, tools, verification, status, diagnostics, errors, JSON result shape, capability availability, compatibility, security limits, and the canonical agent interaction sequence using existing CLI behavior and schemas.

- [ ] **Step 4: Link it from current documentation**

Add the document to the README's architecture/contract references and the docs index if one exists. Mark `paved/agent/v1` as the integration contract version, independent of Core and CLI versions.

- [ ] **Step 5: Run the focused test**

Run: `node --test tests/docs/agent-integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/concepts/agent-integration.md README.md docs/concepts/README.md tests/docs/agent-integration.test.ts
git commit -m "docs: define agent integration contract"
```

### Task 2: Add black-box synthetic-agent contract coverage

**Files:**
- Create: `tests/agent-contract/synthetic-agent.test.ts`
- Modify: `tests/README.md`

- [ ] **Step 1: Write black-box helpers and failing assertions**

Create temporary consumers with existing fixtures, invoke `node cli/index.ts <command> --project <dir> --json` via `spawnSync`, parse JSON, and assert only stable result fields. Cover discovery/version, status, doctor diagnostics, context/skill/workflow availability, verification result, exit-code/category consistency, and lifecycle transitions.

- [ ] **Step 2: Run the focused test**

Run: `node --test tests/agent-contract/synthetic-agent.test.ts`
Expected: FAIL only where the documented contract does not match actual public output.

- [ ] **Step 3: Make the smallest corrective change**

If a mismatch is a real defect, update the existing command/result contract rather than adding agent-specific behavior; add a regression assertion for the defect. If the surface is already correct, adjust the fixture assertion to the existing documented shape.

- [ ] **Step 4: Verify the black-box boundary**

Run: `rg -n 'cli/lib|consumer-state|generator-runtime|\\.paved/(generated|\\.lock)' tests/agent-contract/synthetic-agent.test.ts`
Expected: no matches; the synthetic agent may use only CLI commands and documented public paths.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/agent-contract/synthetic-agent.test.ts tests/cli/cli.test.ts tests/cli/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/agent-contract/synthetic-agent.test.ts tests/README.md cli tests
git commit -m "test: validate agent contract through CLI"
```

### Task 3: Produce the Phase 15 validation report

**Files:**
- Create: `docs/audits/phase-15-final-validation.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the complete check twice**

Run: `npm run check` twice from the repository root and record exact typecheck/test totals from both runs.

- [ ] **Step 2: Run clean synthetic lifecycle validation**

Use a temporary directory outside the repository, invoke documented install/build-equivalent commands, then run `init`, `status`, `generate`, `doctor`, `verify` where the fixture permits it, mutate a generator input, run `update`, and inspect source preservation. Remove the temporary directory after capture.

- [ ] **Step 3: Audit invariants and hygiene**

Check Core neutrality, adapter isolation, consumer isolation, ownership, provenance, determinism, idempotency, failure safety, Gardener approval, source protection, secrets/absolute paths, and Git status. Mark unavailable Apecatus live validation as `DEFERRED`, never `READY`.

- [ ] **Step 4: Write the report**

Include Phase 14 finding disposition, exact test counts, readiness matrix using only `READY`, `BLOCKED`, or `DEFERRED`, stable public contracts, synthetic-agent results, known risks, and concrete Phase 16 requirements. Use the actual `paved/agent/v1` contract and current CLI scope limits.

- [ ] **Step 5: Update the changelog**

Add an `[Unreleased]` entry for the finalized agent-neutral contract and Phase 15 validation artifacts without claiming Codex, Claude, Cursor, OpenCode, remote distribution, or contract-only commands are implemented.

- [ ] **Step 6: Verify documentation and repository state**

Run: `npm run check && git diff --check && git status --short`
Expected: checks pass, no whitespace errors, and only intentional Phase 15 files plus pre-existing worktree changes remain.

- [ ] **Step 7: Commit**

```bash
git add docs/audits/phase-15-final-validation.md CHANGELOG.md
git commit -m "docs: record phase 15 validation readiness"
```
