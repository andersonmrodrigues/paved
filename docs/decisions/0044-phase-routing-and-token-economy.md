# ADR 0044: Phase routing and a one-line prompt reminder

- **Status:** Accepted
- **Date:** 2026-10-31
- **Supersedes:** [0042](0042-natural-language-routing.md) (only how often the full guidance is sent)

## Context

ADR 0042 sends the full routing guidance (about 1.5 KB) with every prompt. Each copy
stays in the conversation, so a long session pays for it again and again, including for
prompts that are not development requests. Separately, Paved told the agent *what* to do
in each phase but not *who* should do it: discovery read whole files into the primary
context, and only implementation had a delegation contract (ADR 0039) with a model
policy.

## Decision

- Each workflow phase declares `routing`: `mode` (`primary`, `subagent` or `cli`),
  `capacity` (`economy`, `balanced`, `frontier`), `reasoning_effort` and a rationale.
  Tiers are relative, never model names; `paved delegation capabilities --host <host>`
  maps them to the host's models.
- `intent`, `plan` and `execute` results carry the active phase's `routing`. Discovery
  and review run in subagents, planning stays in the primary session at the strongest
  tier, and the phases Paved runs itself (validation, verification, evidence, completion)
  are `cli`: the agent only relays them.
- The full routing guidance is sent when a session starts or resumes and after
  compaction or clear. Every prompt gets a one-line reminder that keeps routing on later
  natural-language requests.

## Consequences

The per-prompt cost drops from about 1.5 KB to about 0.3 KB, and the primary session
keeps search results and logs out of its context. Routing is advice: a host without
subagents or per-subagent models runs the phase in the primary session, and Paved never
switches the primary session's model. Hosts that do not emit `SessionStart` still get
the reminder and the managed AGENTS.md block.

## Alternatives considered

- **Keep the full text on every prompt.** Highest adherence, highest recurring cost.
- **Always use a subagent.** A subagent starts cold and re-reads what it needs; for short
  phases that need the conversation (context, planning) that costs more than it saves.
- **Name models in the contracts.** Catalogs change and differ per host; tiers do not.

## References

- [Workflow schema](../../schemas/workflow.schema.yaml)
- [Hook handler](../../integrations/shared/prompt-submit-hook.mjs)
- [ADR 0039](0039-host-native-task-delegation.md)
