# ADR 0051: Stated corrections become rule proposals; review works without a run

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

People correct agents with rules that hold for the whole project ("never edit an applied
migration"). Agents saved these in their own notes or memory, which neither the project
nor the next agent sees, so the person repeated them. [ADR 0049](0049-corrections-feed-the-gardener.md)
feeds the Gardener corrections Paved already records in structured form, and rejects free
text because the Gardener does not copy or interpret unknown text. A stated correction is
free text, but the person chose the words and the agent hands them over deliberately; the
risk ADR 0049 avoids is Paved guessing meaning from text it found, not storing words it was
given.

Separately, the independent review ([ADR 0048](0048-proven-review-findings.md)) exists only
as the `review` phase of a workflow run. People also want it for a branch against `main` or
a range of commits that no run produced.

## Decision

**Stated corrections.** `paved gardener correction --text <words> --evidence <ref>...`
takes the person's statement verbatim and at least one piece of evidence: a project file
with optional lines, a commit or an `http(s)` URL. Free text is not evidence. The command
compares the statement with Core rules, project rules and pending corrections using a
deterministic similarity (normalized equality, else Jaccard over normalized terms). A match
of 0.6 or more with an existing rule writes nothing and names it; with a pending
correction, the statement and evidence merge into that draft and the occurrence count
grows. Otherwise the command writes a draft Rule to the disposable
`.paved/generated/proposals/rules/corrections/` with a `GeneratedArtifact` sidecar whose
provenance holds the statements as `human` sources and the evidence with digests, and
`proposal_for` naming `.paved/rules/corrections/<slug>.yaml`.

Each pending draft is a project decision through the existing decision gate. Only a
person's `adopt` answer writes `.paved/rules/`; `decline` is recorded and re-asked only
when the draft's evidence changes. One stated correction is enough: the person who states
it has agreed the correct behavior, which is what the two-incident threshold stands in for
otherwise. The core instructions and the `gardener` skill tell agents to use this after a
correction instead of their own notes.

**Run-less review.** `paved review --base <ref>` (merge base with `ref` to the working
tree, untracked files included) or `--range <a>..<b>` (`a...b` uses the merge base) writes
the diff and a brief under `.paved/generated/reviews/`. The `ChangeReview` schema gains an
alternative form: `target` (kind, ref, base and head commits, `working_tree`) with
`reviewed.diff_sha256`, mutually exclusive with `run` and the run digests.
`paved review --evidence <record>` applies the review gate's rules to that form: valid, not
bound to a run, same target and diff digest, isolated reviewer, executed or reproduced
proof for each blocking finding. No run, gate or decision is created; proven blocking
findings return a warning for the person.

## Consequences

- Rules a person states reach `.paved/rules/` through one reviewed decision instead of
  living in agent memory. The adopted rule starts with open scope and `warning` severity;
  the person narrows it.
- Similarity is lexical, so a restatement in different words can produce a second draft,
  and short statements can match loosely. `related` shows partial overlaps so the person
  can decline a near-duplicate. Adapter rules are not compared yet.
- `ChangeReview` stays backward compatible: every record valid before is still valid.
  Records that name both `run` and `target`, or neither, are rejected.
- A run-less review cannot check claims against a plan or evidence; the brief says so and
  points the reviewer at commit messages.

## Alternatives considered

- **Write the stated rule directly to `.paved/rules/`.** Rejected: project rules are
  human-owned and adoption must stay with the person.
- **Require two statements before proposing.** Rejected: the person already agreed the
  behavior, and waiting is what made people repeat themselves.
- **Embedding or model-based deduplication.** Rejected: not deterministic, and the Core does
  no remote analysis.
- **A synthetic workflow run for branch reviews.** Rejected: it would need an intent and
  plan that do not exist, and would put a gate where the person asked only for findings.

## References

- [ADR 0048](0048-proven-review-findings.md), [ADR 0049](0049-corrections-feed-the-gardener.md)
- [Gardener](../concepts/gardener.md#stated-corrections)
- [Workflow state](../concepts/workflow-state.md#review-outside-a-run)
- `schemas/change-review.schema.yaml`
