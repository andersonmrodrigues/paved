# Phase 15 Agent Integration Readiness Design

## Scope

Phase 15 will validate the implemented Paved Core and formalize an
agent-neutral public boundary for Phase 16. It will not implement Codex,
Claude Code, Cursor, OpenCode, remote distribution, or a second agent-specific
API.

The validation target is the existing local CLI and consumer contract. Public
agent-facing operations are represented by the existing machine-readable CLI
results and documented consumer paths:

- discover availability and Core/API compatibility from the project manifest,
  lock and `paved --version`;
- inspect lifecycle, capabilities and diagnostics through `status` and
  `doctor --json`;
- load context, skills and workflows from the resolved public consumer/Core
  content roots;
- invoke supported lifecycle and verification operations through the CLI;
- interpret the existing result shape, diagnostic categories and exit codes.

Internal TypeScript modules, generator implementations, adapter internals,
filesystem traversal details, and disposable state are not public integration
surfaces.

## Approaches considered

1. **Add a new integration API or daemon.** Rejected: it duplicates existing
   contracts, expands scope, and would require premature distribution and
   security decisions.
2. **Expose raw `.paved` files only.** Rejected: agents would have to infer
   lifecycle and freshness, bypassing existing status and diagnostic semantics.
3. **Document and test the existing CLI/contracts as a thin boundary.**
   Selected: it preserves the current architecture, is black-box testable, and
   gives Phase 16 a stable seam without agent-specific conditionals.

## Validation and test design

The phase will add deterministic fixtures and tests that exercise the public
boundary through CLI invocation only. Tests will cover discovery, context and
content loading, capabilities, status, diagnostics, error/exit mapping,
verification, compatibility metadata, and the synthetic-agent interaction
sequence. The synthetic agent will spawn the CLI and parse `--json` output; it
will not import `cli/lib`, inspect private state, or invoke generators directly.

Validation will also run the full lifecycle in a temporary synthetic consumer,
repeat the complete suite, inspect repository invariants, and record the
unavailable live Apecatus check as deferred rather than claiming it passed.

## Deliverables

- versioned Agent Integration Contract documentation (`paved/agent/v1`);
- explicit public-vs-internal boundary and Phase 16 requirements;
- synthetic-agent black-box contract tests;
- final Phase 15 readiness report with exact test counts and actual deferred
  risks;
- corrective implementation changes only where validation demonstrates a
  defect, each protected by regression tests.
