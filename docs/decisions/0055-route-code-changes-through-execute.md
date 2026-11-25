# ADR 0055: Route code changes through execute from session start

- **Status:** Accepted
- **Date:** 2026-11-24

## Context

[ADR 0054](0054-offer-paved-in-uninitialized-repositories.md) made the `SessionStart`
hook offer Paved in uninitialized repositories, but kept the old guidance for broken and
initialized ones: "Work directly". In a repository whose `.paved/` had lost its manifest
(state excluded from Git, runtime folder left behind) while `AGENTS.md` still told the
agent to use Paved, the agent took "broken ... work directly" as permission to skip Paved,
never offered to repair it, and shipped a change across shared components without rules,
plan approval or recorded verification. The same line also reached healthy repositories,
where it contradicts the managed `AGENTS.md` block that routes change requests through
`paved execute`.

## Decision

- A broken repository gets the same once-per-session question as an uninitialized one,
  phrased as repairing Paved: before the first code change, ask whether to repair and use
  it. On yes, run the execute command with the request; it sets Paved up as needed. On
  "not now", work directly and do not ask again that session.
- The uninitialized offer also points to the execute command instead of init followed by
  a separate step, since execute initializes when needed.
- An initialized repository is told to route code changes through the execute command
  and to answer questions directly; explicit user direction still wins.
- Nothing is initialized or repaired without the user's yes, and the hook stays
  stateless.

## Consequences

The session-start guidance no longer contradicts the managed `AGENTS.md` block, and a
repository with damaged state gets a visible repair path instead of a silent bypass. The
guidance stays within the existing size budget. As in ADR 0054, a "not now" answer lives
in the conversation, so a new session asks again.

## Alternatives considered

- **Repair broken state automatically.** Writes to a repository without consent, which
  the lifecycle contract forbids.
- **Keep "work directly" and rely on `AGENTS.md`.** That is what failed: the hook's line
  is the more recent and more specific instruction, so agents follow it.
- **Point to init for broken state.** Works, but leaves the agent to start the request
  separately; execute already initializes when the manifest is missing, updates when the
  state needs it, and records the request in one step.

## References

- [Hook handler](../../integrations/shared/prompt-submit-hook.mjs)
- [Hook tests](../../tests/integrations/prompt-submit-hook.test.ts)
- [ADR 0054](0054-offer-paved-in-uninitialized-repositories.md)
- [Repository lifecycle](../concepts/repository-lifecycle.md)
