# Paved (Predictable Agent Verification & Engineering Discipline)

Paved is an engineering framework that lets AI agents work across many software
repositories along predictable, verifiable, project-specific paths.

This repository is the **Paved Core**: the universal knowledge, contracts and
mechanisms. Repositories that use Paved (consumers) keep their own knowledge in a
`.paved/` directory and reference a Core version; they never copy the Core.

> Status: **first local production CLI implemented (0.2.0 unreleased)**.
> Contracts, schemas, Core content and self-tests exist. The local `paved` CLI
> implements `init`, `update`, `generate`, `verify`, `status`, `doctor` and `gardener` over
> shared validation, adapter resolution, Tool policy, evidence assessment and the
> Generator Runtime. `paved evidence` and `paved tool ...` remain contract-only. See the
> [bootstrap review](docs/getting-started/bootstrap-review.md), the
> [architecture review](docs/getting-started/architecture-review.md), the
> [schema review](docs/getting-started/schema-review.md), the
> [skills review](docs/getting-started/skills-review.md) and the
> [workflows review](docs/getting-started/workflows-review.md), and the
> [verification review](docs/getting-started/verification-review.md) and
> [Tools review](docs/getting-started/tools-review.md).

Core skills use repository status, diff and history capabilities. The Git adapter binds
those capabilities for Git repositories; other repositories need a compatible adapter
binding. See [ADR 0019](docs/decisions/0019-source-control-boundary.md).

## 1. The problem

An agent that enters a repository without guidance tends to:

- invent structure where the repository already has a pattern;
- guess project facts (entities, conventions, commands) and act on the guess;
- stop at "it compiles" or "the tests I ran pass" and report success;
- repeat the same mistake in every session, because corrections are not captured anywhere.

Writing longer prompts does not fix this. The knowledge ends up spread across tools,
goes stale, is not project-specific, and nothing checks that it is followed.

## 2. The paved path

A paved path is the well-supported way to do a kind of work in a codebase: known
context, known constraints, known way to prove the result. Paved makes that path explicit
and machine-checkable for agents:

- **Workflows** say which phases a kind of task goes through.
- **Skills** say how to carry out a kind of work.
- **Rules** say what must hold, and how compliance is shown.
- **Tools** expose governed capabilities through stable contracts and explicit bindings.
- **Verification** says which checks prove which claims.
- **Evidence** records the proof.
- **The Gardener** turns recurring mistakes into stronger paths.

## 3. Context + constraints + verification

Each is necessary; none is sufficient.

| Without | The agent… |
|---|---|
| Context | follows the rules and passes the checks while solving the wrong problem, the wrong way for this codebase |
| Constraints | understands the code but crosses boundaries, leaks secrets, invents patterns |
| Verification | produces plausible changes nobody can trust without redoing the work |

Paved treats verification as central: every claim a change makes needs a passed check or
artifact able to support that *kind* of claim. A successful build supports no behavioral
claim, and the evidence assessment enforces that ([verification](core/verification/README.md)).

## 4. Multi-repository architecture

```text
 Paved Core (this repo) ──┐
                          ├──► consumer A/.paved/  (context, rules, profile, overrides)
 Adapters (per tech) ─────┤
                          └──► consumer B/.paved/
```

The Core is versioned and domain-agnostic. Each consumer declares the Core range and
adapters it uses in `.paved/manifest.yaml`, and holds everything project-specific
itself. The consumer layout and the ownership of every path are part of the Core
contract (`consumer_layout` in [manifest.yaml](manifest.yaml)). Details:
[multi-repository architecture](docs/concepts/multi-repository.md).

## 5. Core, Adapter, Project Context, Override, Generated

| Layer | What | Where |
|---|---|---|
| Core | How agents work, for any repository | this repository |
| Adapter | How a technology works | `adapters/<category>/<name>/` |
| Project Context | How this project works (generated, then reviewed) | consumer `.paved/project/` |
| Override | Reasoned adjustments to Core or adapter content, by reference | consumer `.paved/overrides/` |
| Generated | Disposable, regenerable output | consumer `.paved/generated/` |

Generators may never overwrite human-owned knowledge; see
[ownership and regeneration](docs/concepts/ownership-and-regeneration.md). Inherited
content is modified only through typed overrides; see
[inheritance](docs/concepts/inheritance.md). Full picture:
[architecture](docs/concepts/architecture.md); decisions: [docs/decisions](docs/decisions/README.md).

## 6. Lifecycle

**Repository:** `paved init` discovers local adapters, locks exact inputs and drafts
context. A consumer becomes ready only after it has a valid verification profile and
no outstanding blocking state. `paved update` plans changes, validates overrides and
project documents, stages affected generation and commits recoverably. Unknown
compatibility or a required document migration blocks the update.
See [repository lifecycle](docs/concepts/repository-lifecycle.md).

**Task:** context → discovery → planning → implementation → validation → verification →
evidence → review → completion. See [lifecycle](core/instructions/lifecycle.md).

## 7. Repository structure

```text
.
├── manifest.yaml, VERSION, CHANGELOG.md, LICENSE
├── core/
│   ├── instructions/   # AGENTS.md (agent entrypoint), principles, lifecycle
│   ├── skills/         # <category>/<name>/{SKILL.md, skill.yaml}
│   ├── workflows/      # <name>/{WORKFLOW.md, workflow.yaml}
│   ├── verification/   # verification model, check-type and evidence registry
│   ├── rules/          # <category>/<name>.yaml
│   ├── tools/          # <group>/<name>.yaml
│   ├── tool-implementations/ # Core capability bindings
│   └── templates/      # starting points for every document kind
├── generators/         # nine generator contracts
├── adapters/           # technology adapters; Git source-control bindings
├── schemas/            # JSON Schema (draft 2020-12, authored in YAML); see docs/concepts/schemas.md
├── cli/                # local CLI commands, command docs and shared libraries
├── docs/               # concepts, decisions (ADRs), getting started, maintenance
└── tests/              # self-tests of every contract
```

Agents working **on** this repository start at [AGENTS.md](AGENTS.md). Agents working in
a consumer start at [core/instructions/AGENTS.md](core/instructions/AGENTS.md).

## 8. Versioning

The Core version (SemVer), the document API version (`apiVersion: paved/v1`), adapter
versions and generator versions are independent. Consumers declare ranges; the CLI locks
exact versions and checks compatibility. See [versioning](docs/concepts/versioning.md).
Every document kind has a schema; see [schemas](docs/concepts/schemas.md),
[contracts](docs/concepts/contracts.md) and [references](docs/concepts/references.md).
Skills have their own versions and lifecycle; see [skills](docs/concepts/skills.md),
[skill discovery](docs/concepts/skill-discovery.md),
[progressive disclosure](docs/concepts/progressive-disclosure.md) and
[skill composition](docs/concepts/skill-composition.md). Workflows orchestrate skills
through the task lifecycle with inputs, gates, approvals, failure codes and run records;
see [workflows](docs/concepts/workflows.md), [stages](docs/concepts/workflow-stages.md),
[failure](docs/concepts/workflow-failure.md), [approval](docs/concepts/workflow-approval.md)
and [state](docs/concepts/workflow-state.md). Verification uses
[checks](docs/concepts/checks.md), [evidence](docs/concepts/evidence.md) and
[deterministic completion](docs/concepts/verification.md).
Tools expose capabilities independently of implementation; see
[Tools](docs/concepts/tools.md), [safety](docs/concepts/tool-safety.md),
[resolution](docs/concepts/tool-resolution.md) and [results](docs/concepts/tool-results.md).

## 9. Extensibility

- **Add Core content** (skills, workflows, rules, tools, check types, document kinds):
  [evolving the Core](docs/maintenance/evolving-the-core.md).
- **Add technology knowledge:** write an adapter ([adapters/](adapters/README.md)).
- **Customize for a project:** project rules, skills, tools, workflows and verification
  in `.paved/`, plus [overrides](docs/concepts/inheritance.md) for inherited content.
- **All extension points:** [extensibility](docs/concepts/extensibility.md).
- **Improve the path:** the [gardener skill](core/skills/gardener/gardener/SKILL.md).

## Development

Requires Node.js 22.18 or later (TypeScript runs natively through type stripping).

```bash
npm ci
npm run check   # strict type check + all tests
npm run paved -- --help
```

See [tests/README.md](tests/README.md) for what the tests prove.

The stable, agent-neutral integration boundary is documented in
[Agent Integration Contract](docs/concepts/agent-integration.md). It projects
existing CLI, consumer-layout, lifecycle, schema and diagnostic contracts; it
does not implement an agent-specific integration.

## 10. Roadmap

Phase 08 adds the experimental Generator Runtime and first consumer pilot. Context
generators describe observed repository state, while verification remains a draft
proposal, Rules supports a narrow Checkstyle proposal, and skills and tools remain
contract-only. Managed-block replacement
requires a trusted baseline; otherwise the runtime writes a proposal. See
[generators](generators/README.md) and
[ownership and regeneration](docs/concepts/ownership-and-regeneration.md).

Phase 09 adds the local adapter framework, capability resolution and static
evidence plumbing. Adapter content in the working tree is experimental and should
be read as framework exercise material, not as a tracked Phase 10 guarantee for
specific customer technologies. See [adapters](docs/concepts/adapters.md).

Phase 10 delivers the first local production CLI for `init`, `update`, `generate`,
`verify`, `status` and `doctor`. The update path is local-only, verification is
explicit-profile only, and `evidence`/`tool` command families remain contract-only.

Phase 11 adds derived lifecycle states, consumer-isolated update planning,
source and contract staleness checks, override target validation and a staged local
update commit. Automatic schema migrations and remote distribution remain planned.

Phase 12 adds a read-only, consumer-scoped Gardener that turns recurring Evidence
failures and Generator Runtime signals into deterministic, human-reviewed improvement
proposals. See [Gardener](docs/concepts/gardener.md).

Subsequent milestones include distribution packaging, CI integration, richer command
families and additional adapters.

## License

[MIT](LICENSE)
