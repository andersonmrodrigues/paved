# Skills generator

## Input

Contribution guides, runbooks, scripts, repeated change patterns in version history;
Core and adapter skills.

## Output

Proposed project skills or skill addenda under `.paved/generated/proposals/skills/`.
Skills and overrides are project- or human-owned; a human adopts proposals.

## Preconditions

Architecture context exists. Core and adapter skills are resolvable, to avoid duplicates.

## Sources analyzed

Runbooks and how-to documents, repeated multi-file change patterns in history, scripts
that encode procedures.

## Strategy

1. Find procedures the project documents or repeats.
2. If a Core or adapter skill covers the procedure, propose an addendum instead of a new skill.
3. Otherwise propose a skill using `templates/skill.md` and `templates/skill.yaml`,
   citing the source for every step.

## Limitations

Procedures that live only in people's heads are invisible. History-based detection
needs enough history to be meaningful.

## Unknown information

Steps whose rationale or order is unclear are marked in the proposal as questions.

## Avoiding invention

Every step in a proposed skill cites a document, script or change. No step is added
because it is common practice elsewhere.

## Change detection

On demand only; skills change deliberately.
