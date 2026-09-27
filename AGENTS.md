# Working on the Paved Core

This repository **is** the Paved Core, not a consumer of it. There is no `.paved/`
directory here on purpose.

- Read [README.md](README.md) for what Paved is and how it is laid out.
- The agent instructions shipped to consumers live in `core/instructions/`; they are
  product content, not instructions for working on this repository.
- Keep the Core domain-agnostic: no application entities, services, APIs or business
  rules; no technology specifics outside `adapters/`.
- Every contract has a schema in `schemas/` and tests in `tests/`. Run `npm run check`
  (strict type check + all tests) before considering any change done.
- Follow [docs/maintenance/evolving-the-core.md](docs/maintenance/evolving-the-core.md)
  when adding skills, workflows, rules, tools, adapters, generators or document kinds.
- Version and changelog rules: [docs/concepts/versioning.md](docs/concepts/versioning.md).
- Component boundaries are declared in `components` in [manifest.yaml](manifest.yaml) and
  enforced by tests; see [docs/concepts/boundaries.md](docs/concepts/boundaries.md).
  Significant decisions are recorded in [docs/decisions/](docs/decisions/README.md).
