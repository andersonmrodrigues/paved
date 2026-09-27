# Bug fix

## When to use

The system behaves differently from its intended behavior. If the intended behavior is
itself in question, resolve that with a human first; it may be a feature request. When
production is impaired now, run `incident` first and this workflow afterwards.

## Phases

- **context:** get the raw failure (error, logs, steps). Do not start from a theory.
- **discovery → implementation:** `bug-investigation` runs across these phases and
  brings in root-cause analysis, runtime observation and the regression test at its own
  steps. The phases mark where its gates sit, not new activations.
- **implementation:** `core.testing.regression-test-for-bug-fix` makes the
  `test-failed-first` gate non-negotiable. Two failed fix attempts mean the cause was
  not confirmed: the phase fails as `skill-failed` and discovery is repeated.
- **review:** a fix that does not explain the cause is sent back to discovery.

## Escalation

Stop and ask when the defect cannot be reproduced with the available access, or when the
fix would change behavior other callers depend on.
