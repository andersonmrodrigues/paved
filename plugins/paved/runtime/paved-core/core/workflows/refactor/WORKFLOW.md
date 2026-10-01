# Refactor

## When to use

Changing structure (names, modules, dependencies, duplication) without changing
behavior. If a behavior change is needed too, do it as a separate feature or bug task.

## Phases

- **discovery:** the invariants are what the refactor must preserve: results, errors,
  side effects and public interfaces. If tests do not pin them, the `behavior-pinned`
  gate sends you to add characterization tests; only a human can accept the risk of
  going without (`uncovered-risk`).
- **planning:** prefer many small, independently passing steps over one large move.
  `core.architecture.respect-declared-boundaries` applies to every intermediate state.
- **implementation:** a failing step is undone, not repaired forward; the phase allows
  three attempts before it needs a human.
- **verification:** a `non-regression` claim needs behavior checks; a `structure` claim
  needs an architecture check or a review artifact.

## Escalation

Stop and ask when the refactor turns out to require a behavior change, or when it grows
beyond the scope agreed in context.
