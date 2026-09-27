# Bootstrap review (0.1.0)

This records the bootstrap state and its then-open decisions. For the current
implementation state and next milestone, see the [README](../../README.md).

A short record of what the architectural bootstrap created, which decisions it made,
which it left open, and what to do next. Paved is **not** production ready: nothing here
has been used on a real consumer repository yet.

> This is a snapshot of the bootstrap. Several open decisions below (project workflows,
> override semantics, provenance) were settled later; see the
> [architecture review](architecture-review.md).

## Starting point

The repository had no build system, language, CI, release setup or documentation. It
did contain a `.paved/` directory: about 120 empty placeholder files and a 22-line
`AGENTS.md`, laid out as a single-repository consumer. It was removed, because the Core
repository must not look like a consumer of itself. The ideas from its `AGENTS.md`
(follow existing patterns, verify with evidence, enforcement priority) are now in
`core/instructions/`.

## What was created

- **Root:** README, MIT LICENSE, CHANGELOG, VERSION, the Core `manifest.yaml` (with the
  machine-readable consumer layout and ownership model), and a root `AGENTS.md` for
  agents working *on* the Core.
- **Instructions:** agent entrypoint, ten principles, and the task and repository lifecycles.
- **Schemas (12, JSON Schema 2020-12 in YAML, `apiVersion: paved/v1`):** common,
  manifest (Core and Project), adapter, rule, skill, workflow, tool, evidence,
  verification profile, feature, overrides, generator.
- **Core content, all domain- and technology-agnostic:** 9 skills (one per category),
  6 workflows, 7 rules across the 5 categories, 2 read-only Git tools, and the
  verification model with a check-type and evidence registry.
- **Templates** for every document kind.
- **Generators:** 9 contracts (`status: contract`) with documented input, output,
  strategy, limitations, and handling of unknowns. None is implemented.
- **Adapters:** contract, scope rules and a quality bar. No adapter content.
- **CLI:** contracts for `init`, `update`, `generate`, `verify`, `status` and `doctor`,
  plus a working shared library (`cli/lib`: document loading, schema registry, evidence
  assessment).
- **Docs:** architecture, multi-repository contract, ownership and regeneration,
  versioning, repository lifecycle, integration guide, maintenance guide.
- **Tests (node:test, 141 cases):** they check all of the above. See
  [tests/README.md](../../tests/README.md).

## Architectural decisions

| Decision | Reason |
|---|---|
| Skills are `SKILL.md` (Agent Skills spec) + `skill.yaml` (Paved contract) | The Agent Skills frontmatter only allows `name`, `description`, `license`, `compatibility`, `metadata` (string values) and `allowed-tools`. Adding Paved fields to it would break compatibility with other agents. The sidecar holds only references tooling can check; prose stays in `SKILL.md`, so nothing is duplicated. |
| Every document has `apiVersion` + `kind` | One validator picks the schema by `kind`. The document version can be detected without guessing. |
| Schema ids are URNs (`urn:paved:schema:<name>:v1`) | They are stable and point to no domain that doesn't exist yet. |
| Consumer layout and ownership live in the Core manifest | Enforcement over documentation: tests (and later the CLI) read it. The generator write-permission test depends on it. |
| Evidence has claims typed by kind, checked against a registry | This is how "it compiles ≠ it is correct" becomes executable. A `build` check supports no claim type. |
| Check types: a fixed registry plus `x-` custom types | Projects can extend the list. A custom type supports no claims until the Core registers it, so "custom" can't become a way around verification. |
| Generators may only write to `generated-reviewed` and `disposable` paths | Human knowledge can't be destroyed by construction, and a test enforces it. |
| Overrides work by reference and need a reason; some rules are `overridable: false` | Principle 7. Core safety rules (secrets, evidence, boundaries, unknowns) stay fixed. |
| `.paved/skills/` added to the consumer layout | Project-specific procedures need a home that is neither the Core nor an override. |
| `build` added to the check types | Needed so the evidence model can state explicitly that compilation proves no behavior. |
| Node.js + TypeScript for tooling, no build step | Chosen by the maintainer during the bootstrap. Node ≥ 22.18 runs TypeScript directly. Runtime dependencies: `ajv`, `yaml`. |
| Ajv `strictRequired` disabled | Conditional `required` in `if/then` is idiomatic JSON Schema. Every other strict check stays on. |
| No linter configured | Nothing to justify the extra dependency yet. `tsc` runs in strict mode with the unused-code checks on. |

## Open decisions

1. **Core distribution:** npm package, release archive, Git tag or submodule. This decides how `paved update` resolves versions and what `paved.lock` contains.
2. **Resolved Core cache:** whether `.paved/generated/core/` should be committed for agents that can't run the CLI (for example cloud agents). The path `.paved/generated/core/core/...` is also awkward.
3. **Adapter repository model:** adapters live in this repository but have their own versions. They might move to separate repositories.
4. **Adapter freshness policy:** the maximum age of `reviewed_at` before tooling warns.
5. **Evidence persistence:** local and disposable now. Open: whether to attach it to PRs or CI, and in what format.
6. **Review workflow for generated context:** how review status is set (by hand, or a `paved review` command). Also whether `.paved/generated/state/` should be committed.
7. **Structured architecture context:** architecture is Markdown for now. A schema for components and boundaries would let architecture checks be generated.
8. **Project workflows:** projects can adjust Core workflows but can't define new ones yet.
9. **Tool execution runtime:** contracts describe commands only. Nothing enforces input patterns, timeouts or confirmation at runtime yet.
10. **CLI surface details:** exit codes, `--json` and `--dry-run` are specified but provisional until an implementation tests them.
11. **Git assumption at bootstrap:** Core tools assumed Git. ADR 0019 moved Git bindings to an adapter.

## Limitations

- Nothing is exercised against a real consumer, so the contracts are hypotheses.
- Generators, the CLI and override resolution are specification only.
- Compatibility checking (SemVer ranges) is specified, not implemented.
- Some things tests can't enforce: domain agnosticism of Core prose, and skill quality. They depend on review; a keyword scan found no domain or technology terms in `core/` or `generators/`.
- The layout is described in two places, the manifest (canonical) and the concept docs (explanatory). Changes to one need the other updated by hand.
- This directory is not a Git repository yet, and there is no CI.

## Recommended next steps

1. Initialize Git, add CI that runs `npm run check`, and decide the distribution channel.
2. Implement `paved doctor` and `paved verify --evidence` on top of `cli/lib`. These give the most enforcement for the least code.
3. Write one language adapter and one framework adapter from official sources, to test the adapter contract.
4. Implement the `verification` and `project-context/feature-map` generators, the most deterministic ones, together with the merge strategy.
5. Integrate one real repository by hand, following [integrating a repository](integrating-a-repository.md). Record every friction point as a Gardener input to the Core.
