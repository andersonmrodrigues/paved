# 0040. Task-level harness experiments

- Status: accepted
- Date: 2026-10-24

## Context

Harness2 describes task-level harness optimization through proposed variants, controlled
probing and evidence-based composition. Paved already delegates execution to host-managed
Claude Code and Codex sessions and has paired evaluation support. It must remain provider
agnostic, preserve explicit approval, and avoid treating an agent's report as verified
evidence.

## Decision

Allow an approved delegation graph to declare a bounded experiment group containing one
baseline and up to two candidate tasks. All alternatives share dependency and file scopes;
Paved requires isolated worktree execution for group members. Experiment metadata is
covered by the graph approval digest. Harness refinement remains optional, and results
inform human review rather than automatically changing persistent instructions.

## Consequences

The host continues to own session creation, concrete model selection, isolation mechanics,
and reported usage. Paved can enforce graph shape and analyze recorded results but does not
promise that a candidate is better. Evaluation requires equivalent checks and accepted
independent review; incomplete comparisons are inconclusive. No direct provider integration
is added.

## Alternatives considered

- Automatically promoting a successful candidate was rejected because task-level
  results do not establish a universal policy and Paved keeps instructions human-owned.
- Direct provider API execution was rejected to preserve the Claude Code/Codex host
  execution boundary.

## References

- [Harness2](https://github.com/google-research/harness2)
- [Harness refinement concept](../concepts/harness-refinement.md)
