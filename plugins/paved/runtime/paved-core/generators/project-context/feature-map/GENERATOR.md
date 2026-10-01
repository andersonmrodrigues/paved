# Feature map generator

## Input

Entrypoints (routes, handlers, commands, screens), tests, module boundaries; architecture
and product context.

## Output

One `Feature` document per feature under `.paved/project/feature-map/<id>.yaml`
(schema: `schemas/feature.schema.yaml`), linking entrypoints, code paths, tests, context
documents and profile checks.

## Preconditions

Architecture context exists. Product context helps name features but is not required.

## Sources analyzed

Routing and handler registration, CLI command definitions, UI routes, test files and test
names, module and package structure.

## Strategy

1. Enumerate entrypoints deterministically with adapter patterns.
2. Group entrypoints into candidate features by module, route prefix and shared code.
3. Attach tests by import and naming relationships.
4. Name each feature from existing names in code or docs; mark grouping and naming `inferred`.

## Limitations

Grouping entrypoints into features is a judgement call; expect humans to merge, split
and rename entries. Cross-cutting features (for example audit logging) map poorly to
entrypoints.

## Unknown information

Features without tests, entrypoints that fit no group, and unclear feature purposes are
recorded as `unknowns` on the relevant entry.

## Avoiding invention

Every feature has at least one entrypoint or code path that exists. Summaries come from
code or docs; without a source, the summary says so and the gap is an `unknown`.

## Change detection

Source hashes of entrypoint files. New or removed entrypoints mark the map stale; human
edits to entries are preserved by the merge strategy in `generators/README.md`.
