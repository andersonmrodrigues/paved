---
name: threat-modeling
description: >-
  Identifies what can go wrong, security-wise, in a design before or while it is built:
  what is being protected, where the trust boundaries are, which threats apply at each
  and what mitigates them. Use when a change adds a component, interface, data flow,
  integration or new kind of sensitive data, or when asked for a threat model.
---

# Threat modeling

## When to use

In `planning`, for changes that alter how data or control crosses a trust boundary, and
before `security-review` when that review would otherwise have nothing to check against.
It works on the design; it does not need finished code.

## Required context

A description of the change. Useful: the architecture and integrations context (existing
components, boundaries and external systems) and the domain context (what data is
sensitive).

## Preconditions

The design is concrete enough to draw: which components, which data, which flows.

## Procedure

1. **Scope**: the change and the parts of the system it touches.
2. **Model**: list the components, data stores, external actors and flows between them,
   and mark each trust boundary a flow crosses. A table is enough; a diagram helps.
3. **Name the assets**: data and capabilities worth protecting, and who must not reach
   them.
4. **Find threats per boundary crossing**, using the categories in
   [references/stride.md](references/stride.md) as a checklist, not as a form to fill.
5. **Decide per threat**: mitigated (by what, where), accepted (by whom, why), or open.
   Prefer mitigations the architecture already uses.
6. **Turn mitigations into checks**: each mitigation becomes a requirement with a test or
   a review point that `security-review` will verify.
7. **Record** the model in the shape of
   [examples/threat-model.md](examples/threat-model.md), with unknowns listed.

## Tools

None.

## Rules

None beyond those that apply by scope. Acceptance of a risk is a human decision, never
the agent's.

## Verification

None is required: a threat model is a design artifact, checked later through the
requirements it produced.

## Evidence

A review artifact containing the model, the threats and their decisions.

## Completion criteria

- Every flow that crosses a trust boundary was examined.
- Each threat is mitigated, accepted by a named human, or listed as open.
- Each mitigation has a way to be verified.

## Failure modes

| Failure | Signal | Response |
|---|---|---|
| Checklist theater | Every category filled for every flow with generic text | Keep only threats specific to this design |
| Missing boundary | A flow to an external system has no threats listed | Re-draw the model; examine it |
| Agent accepts risk | A threat marked accepted with no human named | Mark it open; ask |
| Model without follow-up | Mitigations have no check | Add the requirement or review point |

## References

- [references/stride.md](references/stride.md): threat categories and typical
  mitigations.
- [examples/threat-model.md](examples/threat-model.md): a synthetic threat model.
