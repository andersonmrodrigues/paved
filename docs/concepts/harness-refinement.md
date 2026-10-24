# Harness refinement

Harness refinement is an optional task-level experiment for comparing how an agent is
configured to do a bounded task. It follows the Propose–Probe–Compose idea described by
[Google Research's Harness2](https://github.com/google-research/harness2): propose a
small set of harness changes, probe alternatives against the same task, and retain
evidence before composing a reusable lesson.

Paved models alternatives as members of one `experiment.group` in a `DelegationPlan`.
A group contains exactly one baseline and one or two candidates. Candidates share the
same dependencies and read/write scopes; they are alternatives and cannot be a
dependency of another task. The approved graph digest covers their experiment labels
and proposed changes. Each group member must run in a host-managed isolated worktree.

Compare the same acceptance criteria, configured checks, review requirements, and
starting revision. Record repeated outcomes in the `HarnessEvaluation` document and run
`npm run benchmark:harness -- <evaluation.yaml>` for a deterministic recommendation.
The analyzer requires paired repetition ids and accepted independent review, then
compares criterion-level quality before tokens, cost, or duration. When several
candidates qualify, it retains the baseline until a human chooses between them; it does
not invent weights for competing metrics. Review status, evidence references and host
usage are supplied in the record and are not independently verified by the analyzer.
Usage measurements are reported by Claude Code or Codex and are not independently
verified by Paved. A missing check, mismatched setup, or missing independent review
makes the comparison inconclusive. The baseline remains the default on a tie.

This is an opt-in procedure, not a request to spawn experiments for routine work. It
does not introduce provider APIs or model catalogs: Claude Code and Codex remain the
session executors and select concrete models. A result from one task is not a persistent
policy. Repeated evidence can be brought to Gardener for a human-reviewed proposal.

See [harness-refinement skill](../../core/skills/testing/harness-refinement/SKILL.md)
and [delegation evaluation](../evaluations/delegation/PROTOCOL.md) for operating
guidance and the existing paired evaluation protocol.
