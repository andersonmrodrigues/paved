# Technology adapters

An adapter packages reusable knowledge about one technology: how to detect it, how
projects using it are usually structured, which checks it offers, and technology-specific
skills, rules and tools. Adapters sit between the domain-agnostic Core and the
project-specific context.

**No adapter content exists yet.** This directory defines the contract so adapters can be
added without changing the Core.

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

Categories: `languages`, `frameworks`, `infrastructure`, `databases`. An adapter id is
`<category>/<name>` (for example `frameworks/spring`), matching its directory.

## How adapters are used

1. **Detection.** `paved init` evaluates each adapter's `detect` signals against the
   consumer repository and *proposes* matching adapters.
2. **Confirmation.** A human confirms the list in `.paved/manifest.yaml`, with a version range.
3. **Resolution.** `paved update` resolves exact versions into `.paved/paved.lock` and
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
