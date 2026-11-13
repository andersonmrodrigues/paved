# ADR 0048: Blocking review findings carry executed proof

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

The [independent review](../concepts/workflow-state.md#independent-review) records its
findings in a `ChangeReview` as `blocking` or `note`. A blocking finding stops the run and asks the user to
fix or accept it, but it was only an assertion: a reviewer that misread the code could
hold a correct change, and the user had no way to tell a demonstrated defect from a
plausible one without redoing the review. Reviewers, human or agent, are most often
wrong about defects they reasoned about and never ran.

## Decision

Each finding may carry an optional `proof`: a `level` on an ordered ladder `asserted <
cited < reasoned < executed < reproduced`, plus `command` and `output_sha256` (required
by the schema for `executed` and `reproduced`) and an optional `expected`. The field is
additive: the schema stays `urn:paved:schema:change-review:v1` and existing records stay
valid.

The review gate (`cli/lib/workflow-gates/review.ts`) refuses a record with a blocking
finding below `executed` with `PAVED_REVIEW_FINDING_UNPROVEN`, naming each finding and
its level, and tells the reviewer to prove it or record it as a note. Notes at any level
are accepted. The rule lives in the gate rather than in a schema `if`/`then`, so the
schema keeps describing every record ever written and the gate can honor in-flight
decisions.

`executed` covers any command that runs against the real code and shows the defect: a
test, a script, a build, a boundary or rule check, or the repository diff for an unexplained
hunk. Structural findings (boundaries, rules, scope) can therefore still block, as long
as a command shows them.

Paved does not re-run the command: review commands are not declared Tools with a safety
class, and re-running arbitrary reviewer commands would cross the Tool safety boundary
([ADR 0018](0018-tool-safety-and-evidence.md)). The digest binds the finding to one
captured output that a person can reproduce, the same way evidence binds claims to
observations ([ADR 0005](0005-verification-evidence-separation.md)).

**Records before this version.** A record the user already answered (an applied
`run.review` decision whose evidence digest matches the record) keeps its decision and is
not re-checked, so a run resumed after the update is never sent back. A record not yet
answered is checked: the refusal only asks the reviewer to rewrite the findings file,
the run stays in `review`, and no completed run, approved plan or recorded decision
becomes invalid. We treat this as a compatible tightening of how a record is written,
shipped in a Core minor with the `change-review` skill at `0.7.0`. Workflow versions are
not bumped: phases, gates, approvals, required input and evidence kinds are unchanged,
and a bump would make in-flight runs unreadable.

Treating an unproven blocking finding as a note was rejected: it would silently drop a
concern the reviewer wanted to raise.

## Consequences

A blocking finding now reaches the user with the command that shows it, and false
positives cost the reviewer a run instead of costing the user a fix cycle. Reviews take
longer when the reviewer has to write a scratch test. Defects that cannot be run cheaply
(races, rare timing, missing infrastructure) can only be notes; the user still sees them
in the review document with their proof level. The output digest is a reviewer
declaration, like `reviewer.isolated`: it rests on the reviewer following the brief.

## Alternatives considered

- **Schema-level `if severity: blocking then proof.level in [executed, reproduced]`.**
  Breaks existing records against the same `$id` and leaves no room for honoring
  decisions already made.
- **Paved re-runs the proof command.** Strongest guarantee, but executes an undeclared
  command outside the Tool safety model.
- **A multi-model reviewer panel.** The skill suggests running passes on different
  models when the host offers them; no new delegation machinery is added.

## References

- [Change review schema](../../schemas/change-review.schema.yaml)
- [change-review skill](../../core/skills/code-review/change-review/SKILL.md)
- [Workflow state: independent review](../concepts/workflow-state.md#independent-review)
- [Versioning](../concepts/versioning.md)
