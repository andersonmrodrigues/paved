# Rules generator

## Input

Linter and analyzer configuration, architecture tests, contribution guides, decision
records; evidence records with violated or overridden rules; architecture boundaries.

## Output

Proposed `Rule` documents under `.paved/generated/proposals/rules/`. Rules are
project-owned; a human adopts, edits or rejects each proposal.

## Preconditions

Architecture context exists.

## Sources analyzed

Analyzer and linter configuration, architecture tests, contribution guides, decision
records, evidence records.

## Strategy

1. Turn constraints already enforced by tools into rules that point at that enforcement
   (`mechanism: automated`), so agents know about them before CI tells them.
2. Turn explicit written conventions into rules with `mechanism: review`, citing the text.
3. From evidence, surface rules that are often violated or overridden as Gardener input.

## Limitations

Unwritten conventions cannot be detected. Rules extracted from prose need human judgement
on severity.

## Unknown information

Severity and scope that the source does not state are left at conservative defaults and
flagged in the proposal.

## Avoiding invention

Every proposed rule cites the configuration, test, document or evidence it came from.
No "best practice" rule is proposed without a source in the repository.

## Change detection

On demand, and when analyzer configuration or decision records change.
