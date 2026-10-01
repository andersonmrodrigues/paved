# Architecture generator

## Input

The repository tree, build and module definitions, dependency manifests, container and
deployment files; confirmed adapters from the project manifest.

## Output

Markdown documents under `.paved/project/architecture/`:

- `overview.md`: components (deployable or buildable units), what each is responsible
  for as far as the code states it, and how they depend on each other.
- `boundaries.md`: boundaries the repository *enforces* (module systems, architecture
  tests, dependency rules in build files). Boundaries only described in prose are
  listed separately as `declared`, with their source.

## Preconditions

A valid project manifest. Adapters confirmed, so that technology-specific structure is
interpreted with the right adapter.

## Sources analyzed

Directory layout; build files (modules, subprojects, workspaces); dependency manifests;
container and deployment definitions; architecture tests and linter configuration;
decision records and READMEs.

## Strategy

1. Deterministically enumerate buildable and deployable units from build and deployment files.
2. Resolve dependencies between units from build files and imports.
3. Extract enforced boundaries from architecture tests and build constraints.
4. Summarize each unit's responsibility from its code and documentation; mark these
   summaries `inferred`.

## Limitations

Runtime topology that is configured outside the repository (infrastructure in another
repository, platform defaults) is invisible. Dynamic dependencies (reflection,
configuration-driven wiring, service discovery) are partially visible at best.

## Unknown information

Responsibilities that cannot be read from code or documentation, runtime topology outside
the repository, and ownership are recorded as `unknowns` with questions.

## Avoiding invention

Only units that exist in build or deployment files are listed. Responsibility summaries
quote or reference the source they came from. No layering is described unless it is
enforced or explicitly documented.

## Change detection

Each document records the hashes of its sources. A changed build, module or deployment
file, or a change to the adapter set in the manifest, marks the documents stale.
