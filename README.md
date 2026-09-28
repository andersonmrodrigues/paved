# Paved

Paved is an AI-native engineering framework for making agent work predictable,
verifiable and repository-aware.

It gives a project a durable operating model:

- context that describes the repository
- rules that define project constraints
- skills and workflows that provide a known path for agent work
- tools and adapter knowledge that keep operations explicit
- verification and evidence that prove claims before completion

This repository is the Paved Core: the shared contracts, runtime, schemas and
knowledge that a consumer repository can adopt through its own `.paved/` state.

## Why Paved exists

An agent without project context tends to guess, overwrite, skip evidence and
report success without proof. Paved makes the safe path explicit and
machine-checkable instead of leaving correctness to prompt quality.

## Core concepts

- Paved Path: the supported way to perform a kind of work.
- Context: project-specific knowledge generated and reviewed by humans.
- Rules: constraints that must be honored.
- Skills: task-specific guidance for an agent.
- Workflows: structured phases with approvals and completion checks.
- Tools: capability contracts resolved to concrete implementations.
- Verification: the explicit gate that decides whether work is ready.
- Ownership: human-owned state is protected; generated state is disposable.
- Provenance: a record of where generated knowledge came from.

## Architecture

```text
                    Paved Core
             ┌──────────────┬──────────────┐
             │              │              │
         Context        Skills       Verification
             │              │              │
             └──────────────┼──────────────┘
                            │
                    Agent Integration
                            │
                  ┌─────────┴─────────┐
                  │                   │
               Codex              Claude Code
                  │                   │
                  └─────────┬─────────┘
                            │
                          Agent
```

The Core is agent-neutral. Agent integrations adapt its canonical behavior to an
agent's local packaging and discovery model without becoming the source of truth
for Paved itself.

## Quick start

Requires Node.js 22.18+. Paved is currently distributed as a Core repository
checkout, not as a published npm package:

```bash
git clone https://github.com/andersonmrodrigues/paved.git
cd paved
npm ci
node ./cli/index.ts --help
node ./cli/index.ts --version
```

Run the CLI from the Paved checkout and pass the existing consumer repository
explicitly. Do not initialize the Core checkout as a consumer:

```bash
node ./cli/index.ts init --project /absolute/path/to/existing-repository --json
node ./cli/index.ts status --project /absolute/path/to/existing-repository --json
node ./cli/index.ts generate --project /absolute/path/to/existing-repository --json
```

`verify` requires a project-owned verification profile and approved Tool
bindings; `init` does not create or approve checks. Configure those first by
following [Integrating a repository](docs/getting-started/integrating-a-repository.md),
then run:

```bash
node ./cli/index.ts verify --project /absolute/path/to/existing-repository --json
```

The CLI also supports `doctor`, `update`, `gardener` and `agent`. The `npm run
paved -- <command>` script is a convenience for human-readable output. To make
the `paved` executable available to an agent launched from that shell, add
`<Core checkout>/node_modules/.bin` to `PATH`.

## CLI surface

The implemented public commands are:

- `init`
- `update`
- `generate`
- `verify`
- `status`
- `doctor`
- `gardener`
- `agent`

The `--json` option renders the same data model for scripts and integrations.
The command family `paved evidence ...` and `paved tool ...` remains
contract-only in this release.

## Supported adapters and capabilities

The current adapters are Git, Java, Quarkus, TypeScript, Angular, Dart, Flutter
and PostgreSQL. Reusable Core capabilities include testing structure, HTTP/REST
API evidence and OpenAPI evidence. Evidence providers vary by adapter; when
selected adapters overlap, a project must choose a provider explicitly in its
manifest rather than having Paved guess.

## Supported integrations

Paved currently supports project-local integration projections for:

- Codex
- Claude Code

These integrations project canonical Core skills into each agent's local
discovery layout. The CLI remains authoritative for lifecycle and verification;
the local Core checkout must be available to the agent environment.

## Repository structure

```text
.
├── README.md
├── LICENSE
├── VERSION
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── manifest.yaml
├── package.json
├── core/
├── adapters/
├── generators/
├── integrations/
├── schemas/
├── cli/
├── docs/
├── examples/
├── tests/
└── .gitignore
```

## Documentation

Public documentation lives in:

- [Integrating a repository](docs/getting-started/integrating-a-repository.md)
- [docs/concepts](docs/concepts)
- [docs/decisions](docs/decisions)
- [docs/maintenance](docs/maintenance)
- [cli/README.md](cli/README.md)
- [integrations/README.md](integrations/README.md)

## Extending Paved

Paved is designed to grow through explicit extension points:

- adapters for technology-specific knowledge
- skills for agent guidance
- workflows for task orchestration
- tools and tool implementations for safe capabilities
- verification rules and evidence standards
- agent integrations for local packaging

See [docs/maintenance/evolving-the-core.md](docs/maintenance/evolving-the-core.md)
and [docs/concepts/extensibility.md](docs/concepts/extensibility.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

Paved is distributed under the MIT license. See [LICENSE](LICENSE).

## Status

The source declares Core version 1.0.0. Its first tagged GitHub release has not yet
been published. Paved remains intentionally narrow in scope: the Core stays
agent-neutral, and remote distribution or marketplace installation is not available.
