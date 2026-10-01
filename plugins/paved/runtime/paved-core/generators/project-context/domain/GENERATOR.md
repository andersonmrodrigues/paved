# Domain generator

## Input

Type and schema definitions, database migrations, validation code, API contracts,
existing documentation; the architecture context to know where domain code lives.

## Output

Markdown documents under `.paved/project/domain/`:

- `glossary.md`: terms used in the code and documentation, with where each is defined.
- `model.md`: entities and relationships as the code defines them (types, schemas,
  migrations), and invariants the code enforces (validations, constraints).

## Preconditions

Architecture context exists, so the generator knows which modules hold domain code.

## Sources analyzed

Type definitions and schemas, database migrations and constraints, validation logic, API
specifications, documentation and decision records.

## Strategy

1. Extract entities and fields from schemas, migrations and type definitions.
2. Extract relationships from foreign keys, references and type composition.
3. Extract invariants from constraints and validation code, citing each source.
4. Build the glossary from names that appear across layers; attach definitions only
   when documentation or comments provide them.

## Limitations

Business rules implemented as scattered conditionals are hard to recognise reliably.
Intent behind a rule is rarely in the code.

## Unknown information

Terms without a definition, rules whose purpose is unclear, and apparent contradictions
between layers are recorded as `unknowns` with questions for a domain owner.

## Avoiding invention

No definition is written for a term the sources do not define. An invariant is listed
only with the constraint or validation that enforces it. Industry-typical meanings of a
term are never assumed.

## Change detection

Source hashes of schemas, migrations and domain types; any change marks the documents stale.
