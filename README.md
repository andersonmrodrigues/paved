# Paved

**A reliable way to work with coding agents in real software repositories.**

Paved gives an AI coding agent the project context, constraints and work process it
needs, then checks that the work followed that process. It works with repositories
of different sizes and technologies, from a focused bug fix to a feature that spans
multiple modules.

## Why Paved exists

Coding agents can make useful changes quickly, but they often start without enough
knowledge of a repository. They may miss local conventions, choose the wrong test
command, skip a needed approval, or report success without showing what was checked.

Paved makes the expected way of working visible and repeatable. It discovers what it
can from the repository, asks people to resolve important choices, and keeps project
state and evidence in the repository. The agent does the engineering work; people
remain responsible for product decisions and approvals; Paved provides the shared
process and records its results.

Paved does not promise that software is defect-free. It makes the work, decisions,
checks and remaining gaps easier to inspect.

## How it works

1. **Initialize a repository.** Paved detects project modules and technologies,
   explains choices that need a person, and creates a project-local `.paved/` state.
2. **Understand the project.** Generated context describes the repository. People
   review it and can add project rules where needed.
3. **Choose a workflow.** The agent uses a Paved skill such as `feature`, `fix` or
   `refactor` to plan and carry out the change in phases.
4. **Review and verify.** Required approvals stay with the person. Paved runs the
   configured tests and verification checks and records evidence before a workflow
   can be completed.

![How Paved Core works](docs/assets/how-paved-core-works.svg)

Paved is agent-neutral at its core. Native plugins for Cursor, Codex and Claude Code expose
the same skills and activate a version-pinned runtime in the consumer repository.
The repository's `.paved/` state is the authority for that project's configuration
and runtime version.

## Get started

Install the plugin for your coding agent:

```bash
# Codex
codex plugin marketplace add andersonmrodrigues/paved
codex plugin add paved@paved

# Claude Code
claude plugin marketplace add andersonmrodrigues/paved
claude plugin install paved@paved
```

In Cursor, open **Customize → Plugins → From GitHub Repository**, import
`https://github.com/andersonmrodrigues/paved`, then install Paved.

Open the repository you want to work on and initialize Paved:

```text
Claude Code: /paved:init
Codex:       paved:init
Cursor:      /init
```

Then inspect its setup and choose a workflow. For example:

```text
Cursor:      /status, /feature, /test, /verify
Claude Code: /paved:status, /paved:feature, /paved:test, /paved:verify
Codex:       paved:status, paved:feature, paved:test, paved:verify
```

The launcher verifies and installs the plugin's bundled runtime under
`.paved/runtime/`; it does not add dependencies to your application. The full
[installation guide](docs/getting-started/installing-the-plugin.md) covers updates,
runtime upgrades, removal and troubleshooting. To configure project context and
verification, see [Integrating a repository](docs/getting-started/integrating-a-repository.md).

## Workflows and commands

![How to use Paved commands in development](docs/assets/paved-command-flow.svg)

Use the workflow that matches the change. Paved keeps runs in the repository so an
agent can resume them and people can inspect plans, approvals and results.

| Flow | Use it when… |
| --- | --- |
| `feature` | You want to add or intentionally change behavior. It guides context gathering, planning, implementation, testing, verification and review. |
| `fix` | Existing behavior is wrong. It guides reproduction, root-cause investigation, a regression test, the fix and review. |
| `refactor` | You want to change structure while preserving behavior. It emphasizes recording existing behavior and checking for regressions. |
| `plan` | You need a plan and acceptance criteria before implementation. Plans can be reviewed in the Markdown preview. |
| `debug` | You need to investigate a failure and separate observations from hypotheses before changing code. |
| `implement` | You have an approved plan and want to carry it out. |
| `review` | You want findings about a change, including risks and evidence gaps. Review does not replace verification. |
| `test` | You want Paved to run the test commands explicitly mapped to detected modules. For local Maven dependencies, Paved orders modules and installs dependencies before testing dependents. |
| `verify` | You want to run the repository's configured verification profile. |
| `preview` | You want to review Markdown plans or specs, comment on selected text, and approve the exact current version. |

You can also use `status` to inspect readiness, `doctor` to diagnose setup, `generate`
to refresh project context, and `update` to apply a compatible local Core update.
Some operations depend on project configuration or approvals; Paved reports when
they are unavailable. See the [agent command reference](docs/concepts/agent-commands.md)
for inputs, behavior and availability conditions.

## What Paved provides

- **Project context** generated from repository evidence and reviewed by people.
- **Skills and workflows** that give agents repeatable steps for common engineering work.
- **Adapters** that add technology-specific knowledge while keeping the Core general.
- **Explicit tools and verification** so commands are declared and checks are
  configured for the project.
- **Approvals and evidence** that preserve human decisions and show what was run.
- **Repository-owned state** that can be reviewed and versioned with the project.

Paved currently provides adapters for Git, Java, Quarkus, TypeScript, Angular, Dart,
Flutter and PostgreSQL. Supported integrations are Cursor, Codex and Claude Code. The set of
available commands and checks depends on each repository's detected technologies
and configuration.

## Who makes Paved

Paved was created by **Anderson Rodrigues** and is maintained in the open. Contributions
are welcome; see [Contributing to Paved](CONTRIBUTING.md) for the repository's
development setup and guidelines.

## Project status

The current Core release is **1.8.0**. The Cursor, Codex and Claude Code plugins are available
through this repository's GitHub-backed marketplaces. Paved is not listed in public
agent plugin directories, and `paved-core` is not published to npm; the plugin bundles
the runtime it needs.

## Learn more

- [Install the plugin](docs/getting-started/installing-the-plugin.md)
- [Integrate a repository](docs/getting-started/integrating-a-repository.md)
- [Agent command reference](docs/concepts/agent-commands.md)
- [Conversational decisions](docs/concepts/decisions.md)
- [Architecture](docs/concepts/architecture.md)
- [Extensibility](docs/concepts/extensibility.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)
- [License](LICENSE)
