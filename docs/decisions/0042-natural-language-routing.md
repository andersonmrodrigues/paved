# ADR 0042: Natural-language routing on every prompt

- **Status:** Accepted
- **Date:** 2026-10-31
- **Supersedes:** [0037](0037-session-scoped-prompt-guidance.md)

## Context

Session-scoped guidance reduces repeated context, but leaves later development requests
dependent on the agent remembering an earlier instruction. Users should not need to
invoke a Paved command to get the same process for a natural-language request.

## Decision

- Emit advisory routing guidance on every submitted prompt in an initialized repository,
  retaining restoration after compaction or clear. Remove temporary session markers.
- Reinforce that default in the managed project instructions and canonical agent guide.
  The agent checks status and resumes a run only when it matches the same request.
- Route development through the existing intent, plan and execute contracts; do not
  invent a second workflow or classify requests with keyword heuristics in the hook.
- Preserve scope: planning-only stops at the plan, investigation-only does not implement
  a fix, questions do not start workflows, and unrelated requests proceed normally.
- Preserve explicit user direction and human approval of the current plan. Hook output
  is guidance, not approval or a host-level tool restriction.

## Consequences

Each prompt pays for a short routing reminder. The hook remains stateless and does not
execute commands, store prompt text, create runs or initialize repositories. Existing
host trust controls still apply. The managed block is refreshed through `paved update`;
text outside it remains human-owned. This improves routing consistency but cannot
guarantee model adherence when hooks or project instructions are unavailable.

## Alternatives considered

- **Keep session-only reminders.** Lower context cost, but does not address later prompts
  bypassing the process.
- **Block tools outside a run.** More intrusive and host-specific; not part of this
  advisory integration.
- **Route from prompt keywords in the hook.** Ambiguous requests need context and
  sometimes human decisions, not a second classifier.

## References

- [Hook handler](../../integrations/shared/prompt-submit-hook.mjs)
- [Managed instructions](../../core/templates/AGENTS.md)
- [Hook tests](../../tests/integrations/prompt-submit-hook.test.ts)
- [Agent integration contract](../concepts/agent-integration.md)
