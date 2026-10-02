# Product generator

## Input

Documentation, UI routes and navigation, role and permission definitions, user-facing
text; answers from humans to previously recorded unknowns.

## Output

Markdown documents under `.paved/project/product/`:

- `users-and-roles.md`: roles and permissions as defined in code or configuration.
- `journeys.md`: user journeys that documentation or navigation make explicit.

## Preconditions

Domain context exists, so product terms can be linked to domain terms.

## Sources analyzed

README and docs, route and navigation definitions, permission and role configuration,
localization files and user-facing strings.

## Strategy

1. Extract roles and permissions from code and configuration (`observed`).
2. Extract journeys only from documentation or explicit navigation flows.
3. Everything else becomes a question for humans; answers are recorded as `declared`
   knowledge with the person and date in provenance.

## Limitations

Most product knowledge (personas, goals, priorities, why features exist) is not in a
repository. This generator is mostly a structured interview.

## Unknown information

Expected to be the majority of its output. Unknowns are phrased as questions a product
owner can answer.

## Avoiding invention

No persona, goal or journey is written without a source or a human answer. Plausible
product narratives are exactly what this generator must not produce.

## Change detection

Source hashes for documentation and navigation; re-run on demand when humans answer questions.
