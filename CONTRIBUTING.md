# Contributing to Paved

Thanks for helping improve Paved.

## Repository layout

- `core/` — canonical agent behavior, skills, workflows, rules, tools and verification
- `schemas/` — machine-readable contracts for every Paved document type
- `adapters/` — technology-specific knowledge and bindings
- `generators/` — project-context and proposal generation contracts
- `integrations/` — thin agent projection wrappers
- `cli/` — public CLI runtime and command implementations
- `docs/` — user, contributor and architecture documentation
- `tests/` — contract and integration coverage

## Development setup

```bash
npm ci
git config core.hooksPath .githooks
npm run check
```

The `commit-msg` hook in `.githooks/` rejects `Co-authored-by` lines: commits record one
author. If you already use a global `core.hooksPath`, call `.githooks/commit-msg` from it
instead.

The repository requires Node.js 22.18 or later.

## Coding standards

- Keep the Core domain-agnostic; put repository-specific or technology-specific
  knowledge in adapters or consumer `.paved/` state.
- Preserve the public contract and schema semantics.
- Add or update tests for any behavioral or schema change.
- Keep generated content and human-owned content distinct.
- Prefer explicit validation and deterministic behavior over inference.

## Adding skills, workflows and tools

When you add Core content:

1. Place it in the appropriate directory under `core/`.
2. Follow the canonical templates and required metadata.
3. Update the relevant schemas or references if the contract changes.
4. Add tests that cover valid and invalid cases.
5. Update `CHANGELOG.md` and version metadata when the change is release-worthy.

## Adding adapters

Adapters should only exist when a concrete capability needs technology-specific
knowledge. Keep the adapter contract minimal and explicit, and ensure it is
validated by tests.

## Adding agent integrations

Agent integrations belong in `integrations/` and must remain thin projections of
Core behavior. They should not add lifecycle logic, verification logic, or
Core-specific branches for individual agents.

## Documentation

Documentation changes should be clear, accurate and aligned with the actual
implementation. Do not document behavior that is not present in the CLI, schema or
contract.

## Release expectations

- Keep `VERSION`, `manifest.yaml` and `package.json` aligned.
- Update `CHANGELOG.md` for user-facing changes.
- Run `npm run check` before proposing a release.
- Release through the `release` workflow; see
  [Releasing](docs/maintenance/evolving-the-core.md#releasing).
- Keep public documentation honest about stable vs experimental interfaces.

## Pull requests

Provide a focused change, explain the reason for it, and include the tests or
verification you ran.
