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

## Consumer usage

Open an existing repository, install the Codex or Claude Code Paved integration,
then invoke the native init command:

```text
Codex:       $paved-init, $paved-status, $paved-plan, $paved-feature
Claude Code: /paved:init, /paved:status, /paved:plan, /paved:feature
```

See the [agent command reference](docs/concepts/agent-commands.md) for all
commands, inputs, lifecycle requirements, context, side effects and failures.
The integration's Node launcher acquires the exact `paved-core` package version
pinned by the integration or `.paved/paved.lock`, checks its SHA-512 tarball
integrity, installs it under `.paved/runtime/`, and invokes the packaged CLI.
It never adds a dependency to the application. Subsequent commands use the
verified local installation offline.

**Release status:** `paved-core@1.0.0` has not been published to npm, and no
standalone public integration installer has been released. Registry bootstrap
therefore reports an acquisition diagnostic today. The packaged integration and
bootstrap path are exercised end to end from a local tarball in
`tests/package/bootstrap.test.ts`. Publication and integration distribution are
the remaining public availability prerequisites.

For Paved development, the CLI requires Node.js 22.18+ and a local Core checkout:

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

The packaged CLI uses the same handlers as the agent launcher. `paved agent
commands --json` reports availability, and `paved agent command <name> --json`
resolves one structured command contract. The `npm run paved -- <command>` script
is a contributor convenience.

## CLI surface

The implemented public commands are:

- `init`
- `update`
- `generate`
- `test`
- `verify`
- `status`
- `doctor`
- `gardener`
- `agent`
- `plan`, `implement`, `review`, `debug`, `feature`, `fix`, `refactor`

The `--json` option renders the same data model for scripts and integrations.
The command family `paved evidence ...` and `paved tool ...` remains
contract-only in this release.

`paved test` executes only one explicitly declared `testing-run` Tool with a
valid ToolImplementation, using the bounded process runner and recording
sanitized, incomplete evidence. It does not discover or run application package
scripts, and it does not replace `paved verify`.

`paved feature <request>`, `paved fix <report>`, and `paved refactor <scope>`
create durable runs under `.paved/generated/runs/`. Resume with `--run <id>
--advance`, adding `--note` and `--evidence` when the current phase requires
observations. Planning stops for a plan-specific human approval record under
`.paved/approvals/`; implementation cannot advance without it. Validation calls
the governed testing Tool, verification calls the existing verification engine,
and completion requires workflow evidence with matching check results and a
recorded diff. `plan`, `debug`, `implement`, and `review` use these same runs.

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

These integrations project canonical Core skills and native command prompts
into each agent's local discovery layout. Their prompts invoke the same
project-local bootstrap launcher and CLI dispatcher. A packed CLI runs
independently of its source checkout. Public registry acquisition requires the
unpublished package release.

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
- [Agent command reference](docs/concepts/agent-commands.md)
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

The source declares Core version 1.0.0. Its first npm and tagged GitHub releases
have not been published. The Core remains agent-neutral.
