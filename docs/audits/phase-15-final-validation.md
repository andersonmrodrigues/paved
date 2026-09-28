# Phase 15 — Final Validation and Agent Integration Readiness

**Phase ID:** `PAVED-P15-38147`  
**Validation date:** 2026-09-27  
**Agent Integration Contract:** `paved/agent/v1`

## Final system status

Paved Core is **READY** for Phase 16 agent-integration work within the local
CLI scope. The agent boundary is thin and agent-neutral: integrations consume
documented CLI JSON results, schemas, consumer layout, lifecycle state and
diagnostics. No Codex, Claude Code, Cursor, OpenCode, remote service or
agent-specific Core logic was added.

The Phase 14 medium documentation finding (obsolete historical review wording)
is fixed in the existing review pages. The two Phase 14 deferred items were
validated as follows: the Apecatus checkout is not available in this repository,
so live external validation remains deferred; test-category subtotals remain
unclassified by the Node runner except for the new agent-contract tests.

## Validation evidence

- `npm run check`: passed twice.
- TypeScript strict check: passed.
- Full test run: **493 tests, 493 passed, 0 failed, 0 skipped, 0 cancelled; 71 suites**.
- Clean synthetic consumer: initialized with `paved init --no-generate`, generated
  context, inspected status and diagnostics, and verified that generated output
  stayed inside `.paved/`.
- Black-box synthetic agent: spawned the CLI, consumed only JSON output, checked
  discovery/version, uninitialized diagnostics, initialization, generation,
  lifecycle, lock health, adapter data, and contract-only command behavior.
- Reproducibility: the second full check produced the same 493/493 result.
- Apecatus: **DEFERRED**; no checkout or external CI artifact is present here.

## Readiness matrix

| Area | Status | Evidence | Blocking issue |
|---|---|---|---|
| Core | READY | Boundary and neutrality tests; manifest component model | None |
| Schemas | READY | Schema registry, fixtures and API-version checks | None |
| Generators | READY | Determinism, provenance, ownership and lifecycle suites | None |
| Adapters | READY | Detection, resolution, lock and isolation suites | None |
| Verification | READY | Explicit profile runner, evidence and failure suites | None |
| Tools | READY | Contract, safety and binding tests | `paved tool` remains contract-only |
| CLI | READY | Seven implemented commands, structured JSON and exit mapping | Local distribution only |
| Lifecycle | READY | Synthetic init/generate/status/update lifecycle tests | None |
| Lock | READY | Digest, compatibility and update safety tests | None |
| Ownership | READY | Human-edit preservation and conflict proposals | None |
| Provenance | READY | Source, generator, artifact and evidence references | None |
| Gardener | READY | Read-only analysis and human-review gate tests | None |
| Tests | READY | 493 passing tests, repeated full check | Category subtotals are not runner metadata |
| Documentation | READY | Current README, CLI, consumer and integration contract docs | Apecatus live result is external |
| Agent Contract | READY | `paved/agent/v1` docs and black-box tests | No agent-specific integration yet |
| Plugin Readiness | DEFERRED | Phase 16 requirements below | Packaging/install targets require agent research |

## Public contracts

Stable enough for Phase 16 are:

- CLI commands and `--json` result shape;
- Core and consumer schemas at `paved/v1`;
- consumer manifest, lock and `consumer_layout`;
- project context, skills, workflows, tools and verification contracts;
- lifecycle states and status/doctor data;
- diagnostic fields, categories and deterministic exit codes;
- ownership, provenance, compatibility and update semantics;
- Agent Integration Contract `paved/agent/v1`.

Internal TypeScript modules, generator and adapter implementations, transaction
helpers, staging directories and disposable generated state are not public APIs.

## Synthetic-agent validation

| Capability | Result |
|---|---|
| Discovery | PASS — `--version`, manifest and lock were consumed |
| Context | PASS — generated project context was observed through public state |
| Skills | PASS — contract documents remain resolved content, not implementation imports |
| Workflows | PASS — existing versioned workflow contract remains the source of truth |
| Tools | PASS — unavailable executable command is reported as usage, not fabricated |
| Verification | PASS — verification remains the existing CLI gate; no second mechanism |
| Diagnostics | PASS — JSON diagnostics expose category, code and remediation semantics |
| Errors | PASS — exit status and diagnostic category are consistent |
| Status | PASS — `UNINITIALIZED` and generated lifecycle states are machine-readable |

## Remaining risks

1. **Apecatus live validation** — impact: external consumer compatibility cannot
   be independently claimed from this checkout; reason: the application and CI
   artifact are unavailable; phase: Phase 16 or a dedicated integration run.
2. **Agent packaging conventions** — impact: installation and upgrade behavior
   are not yet standardized; reason: each target agent has its own plugin/skill
   mechanism; phase: Phase 16.
3. **Contract-category reporting** — impact: aggregate tests cannot be split
   automatically into integration/E2E subtotals; reason: existing runner has no
   category metadata; phase: future test-infrastructure work.

## Phase 16 input specification

Phase 16 should implement agent-specific adapters for an initial Codex and
Claude Code evaluation without changing Core. Each adapter must:

- package metadata that declares the required `paved/agent/v1` contract and
  supported Core/API ranges;
- discover Paved from the project-local manifest/lock and invoke the CLI;
- expose context, skills and workflows without copying project state;
- invoke verification and translate structured diagnostics and exit categories;
- distinguish unavailable capabilities from failed capabilities;
- preserve `.paved/` as the authoritative project state;
- define installation, upgrade, uninstall and compatibility behavior without
  silently upgrading Core, consumers or adapters;
- avoid remote transfer, secret persistence, arbitrary command execution and
  bypasses of ownership, lifecycle, verification or Gardener approval.

Agent-specific skill/plugin formats and installation paths remain intentionally
unspecified until Phase 16 research validates them.
