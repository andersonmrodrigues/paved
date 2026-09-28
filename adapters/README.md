# Technology adapters

An adapter packages reusable knowledge about one technology: how to detect it, how
projects using it are usually structured, which checks it offers, and technology-specific
skills, rules and tools. Adapters sit between the domain-agnostic Core and the
project-specific context.

The Git adapter binds Core repository status, diff and history Tools. Technology
adapters include `technology/java`, `technology/quarkus`, `technology/angular`,
`technology/postgresql`, `technology/typescript`, `technology/dart` and
`technology/flutter`. TypeScript, Dart and Flutter are independent adapters;
framework adapters may depend on their language adapter where that dependency is
required by the selected project. Adapter detection, resolution, conflicts and evidence are described in the
maintainer documentation.

Reusable meanings remain capabilities rather than technology adapters. The Core
capability registry includes testing evidence, HTTP API evidence and OpenAPI
contract evidence. Providers report observed repository evidence only; detection
does not recommend a technology, infer quality, or create verification policy.

## Layout

```text
adapters/<category>/<name>/
├── adapter.yaml        # contract (schemas/adapter.schema.yaml)
├── knowledge/          # Markdown loaded on demand by skills and generators
├── skills/<category>/<skill>/   # optional, same format as Core skills
├── rules/<category>/<rule>.yaml # ids: adapter-<name>.<category>.<rule>
├── tools/<group>/<tool>.yaml    # ids: adapter-<name>.<group>.<tool>
└── tool-implementations/<group>/<name>.yaml # bindings for Core or adapter Tools
```

Categories: `technology`, `infrastructure` (the earlier `languages`, `frameworks` and `databases` IDs remain schema-valid). An adapter id is
`<category>/<name>` (for example `frameworks/spring`), matching its directory.
Source-control tooling uses the existing `infrastructure` category; the Git adapter's
namespace is `adapter-git`.

## How adapters are used

1. **Detection.** The local initialization library evaluates each adapter's `detect` signals and records confidence.
2. **Selection.** The consumer manifest records the chosen adapters and ranges.
3. **Resolution.** The local resolver records exact versions in `.paved/paved.lock` and
   checks each adapter's `requires.core` against the Core version.
4. **Consumption.** Generators use adapter knowledge to interpret the repository;
   agents load adapter skills and rules like Core ones. Adapter ToolImplementations bind
   capabilities to environment-specific mechanisms without changing their contracts.

## Quality bar

Technology knowledge ages quickly. To keep adapters from shipping outdated guidance:

- `sources` must cite official documentation with a retrieval date (schema-enforced).
- `reviewed_at` records the last maintainer review. Tooling can flag adapters whose
  review is older than an agreed age (policy still open; see the bootstrap review).
- Adapters state version-specific behavior with the versions it applies to.
- An adapter describes the technology, never a project that uses it.

## Scope boundaries

| Belongs in | Examples |
|---|---|
| Core | "Plan how to prove a change before writing it." |
| Adapter | "This framework registers HTTP handlers through annotations; find them with this pattern." |
| Project | "Our billing module must not call the reporting module." |

Start from `core/templates/adapter.yaml`.
