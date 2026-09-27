# Paved principles

These principles decide design questions that the contracts do not answer. When two
principles conflict, the one listed first wins.

## 1. Repository-specific knowledge stays local

Knowledge about a project (its architecture, domain, conventions, commands) lives in that
project's `.paved/` directory, versioned with its code. It changes when the code changes
and is reviewed by the people who own the code.

## 2. Core remains domain agnostic

The Core knows how agents work, not what any application does. No Core file names a
consumer's services, entities, APIs, databases or business rules. Technology knowledge
belongs in adapters; project knowledge belongs in the project.

*Test:* if a sentence in the Core would be false for some well-built repository, it
belongs in an adapter or in a project.

## 3. Prefer enforcement over documentation

If a constraint can be guaranteed by architecture, a type system, a schema, a linter, CI
or an automated check, put it there. Documentation is the weakest enforcement layer and
the first to be ignored. Rules record *which* layer enforces them (`enforcement.layer`) so
that weak enforcement is visible and can be promoted.

## 4. Verification produces evidence

An agent does not declare success; it presents evidence. Every claim a change makes is
backed by a passed check or an artifact that can actually support that kind of claim.
A successful build supports no behavioral claim.

## 5. Do not invent project knowledge

Unknown information stays explicitly unknown. Generators emit `unknowns` instead of
plausible guesses; agents ask or record the gap. A wrong fact in Project Context is worse
than a missing one, because agents trust it.

## 6. Existing patterns are preferred

Before creating a structure, look for how the repository already solves the same problem
and follow it. Consistency lets humans and agents predict the code. A new pattern needs a
reason recorded in the evidence or in a decision record.

## 7. Overrides extend the Core

Projects customize by reference: change a rule's severity with a reason, append an
addendum to a skill, add a gate to a workflow. They never copy Core content and edit
the copy, because copies stop receiving Core fixes and silently diverge.

## 8. Progressive disclosure

Context is loaded when the task needs it: entrypoint, then workflow, then skill, then
referenced detail. Each layer is small and points to the next. This keeps the agent's
context focused on the task and makes each document cheap to keep correct.

## 9. Generated knowledge must be traceable

Every generated fact records where it came from (generator, version, source files,
revision) and whether a human has reviewed it. Untraceable knowledge cannot be refreshed,
audited or trusted.

## 10. The system must improve over time

A mistake that recurs is a defect in the paved path, not only in the agent. The Gardener
turns recurring corrections into structural improvements at the strongest enforcement
layer available.

## 11. Fail explicitly, toward the stricter behavior

When Paved cannot resolve something (an incompatible version, an invalid document, an
override whose target changed, a check that could not run), it says so and falls back to
the behavior that constrains more: the rule applies unmodified, the claim stays
unsupported, the task stays incomplete. A silent fallback to the looser behavior turns
an error into a hidden exception.
