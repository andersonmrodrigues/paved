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

### User ↕ Agent ↕ Paved

The user owns material project choices. Paved derives what evidence supports, presents
explicit options and applies the user's answer through its contracts. The agent explains
the question and relays the answer; it does not choose for the user or author a human
approval. Missing evidence and unsafe conditions remain blockers, not questions. See the
[decision model](docs/concepts/decisions.md) and its
[canonical agent skill](core/skills/decisions/decisions/SKILL.md).

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
                 Paved plugin (generated)
          skills · launcher · pinned runtime
                            │
                  ┌─────────┴─────────┐
                  │                   │
               Codex              Claude Code
                  │                   │
                  └─────────┬─────────┘
                            │
                          Agent
                            │
               Consumer repository .paved/
          (lock, verified runtime, project state)
```

The Core is agent-neutral. The plugin adapts it to each agent's native plugin
model without becoming the source of truth: workflows, Tools, verification and
evidence run only in the version-pinned `paved-core` runtime that the plugin's
launcher activates inside the consumer repository.

## Install

Paved uses native plugin installation in Codex and Claude Code, with
GitHub-backed marketplace distribution from this repository:

```bash
# Codex
codex plugin marketplace add andersonmrodrigues/paved
codex plugin add paved@paved

# Claude Code
claude plugin marketplace add andersonmrodrigues/paved
claude plugin install paved@paved
```

Then open the repository you want Paved to manage and run the init command:

```text
Claude Code: /paved:init, /paved:status, /paved:plan, /paved:feature
Codex:       paved:init, paved:status, paved:plan, paved:feature (skills)
```

The first command verifies the plugin's bundled `paved-core` runtime against its
pinned SHA-512 integrity, installs it offline under `.paved/runtime/` (ignored by
Git), and records it in `.paved/paved.lock`. Nothing is added to the
application's dependencies, and later commands run offline. Updating the plugin
never switches a repository's runtime silently; `runtime upgrade` and
`runtime rollback` do that explicitly.

Full guide, including verification, updates, removal and troubleshooting:
[Installing the Paved plugin](docs/getting-started/installing-the-plugin.md).
All commands: [agent command reference](docs/concepts/agent-commands.md).

**Release status:** the plugin is installable from this GitHub repository today.
It is not listed in the public Codex or Claude Code plugin directories, and
`paved-core` is not published to npm; the plugin bundles the runtime it needs.

## Developing Paved

Contributors work from a checkout, which requires Node.js 22.18+:

```bash
git clone https://github.com/andersonmrodrigues/paved.git
cd paved
npm ci
npm run check          # strict type check and all tests
npm run build:plugin   # regenerate plugins/paved/ after Core changes
```

The CLI can also run straight from the checkout against another repository. Do
not initialize the Core checkout as a consumer:

```bash
node ./cli/index.ts init --project /absolute/path/to/existing-repository --json
node ./cli/index.ts status --project /absolute/path/to/existing-repository --json
```

`verify` requires a project-owned verification profile and approved Tool
bindings; `init` does not create or approve checks. Configure those by following
[Integrating a repository](docs/getting-started/integrating-a-repository.md).
`paved agent commands --json` reports command availability, and
`paved agent command <name> --json` resolves one structured command contract.

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

Paved supports Codex and Claude Code through one generated plugin
([`plugins/paved/`](plugins/paved/)), listed by
[`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) and
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). The same
skills and launcher can also be projected into a single repository with
`paved agent install codex|claude`. Every surface invokes the same launcher and
CLI dispatcher.

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
├── plugins/          (plugin build and generated plugins/paved/)
├── .agents/plugins/  (Codex marketplace)
├── .claude-plugin/   (Claude Code marketplace)
├── schemas/
├── cli/
├── docs/
├── examples/
├── tests/
└── .gitignore
```

## Documentation

Public documentation lives in:

- [Installing the Paved plugin](docs/getting-started/installing-the-plugin.md)
- [Integrating a repository](docs/getting-started/integrating-a-repository.md)
- [Agent command reference](docs/concepts/agent-commands.md)
- [Conversational decisions](docs/concepts/decisions.md)
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

The source declares Core version 1.0.0 and plugin version 1.0.0. The plugin is
installable from this repository; no npm package, tagged GitHub release or public
plugin-directory listing has been published. The Core remains agent-neutral.
