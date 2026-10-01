# Incident

## When to use

Production or a shared environment is impaired now. Restoring service comes before the
permanent fix, which follows as a `bug` workflow recorded as a follow-up output.

## Phases

- **context:** work from raw signals and keep a timeline as you go.
  `core.quality.unknowns-stay-unknown` matters most here: an unconfirmed cause is
  reported as a hypothesis.
- **discovery:** the one phase this workflow allows to be skipped, and only for
  containment: when impact is growing and a known, reversible action exists, contain
  first and investigate after. Record why in the run.
- **planning:** prefer reversible actions (rollback, disabling a feature, adding
  capacity) over code changes. The `mitigation-approved` gate always needs a human.
- **implementation:** apply only what was approved. A failed mitigation is never retried
  automatically; it goes back to a human.
- **verification:** restoration is proven by runtime signals, not by a passing build.
- **review:** `gardener` looks for the layer that would have prevented or caught it.

## Escalation

Escalate immediately when impact is growing, when the only available mitigation is
destructive, or when you lack access to confirm restoration.
