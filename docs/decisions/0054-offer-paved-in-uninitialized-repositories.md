# ADR 0054: Offer Paved in uninitialized repositories

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

In a repository without a Paved manifest, the `SessionStart` hook said only that the
repository was uninitialized and told the agent to "work directly". Agents read that as
"Paved does not apply here" and made code changes, including production fixes, without
ever offering Paved, even though the plugin was installed and the user wanted it. The
per-prompt reminder ([ADR 0044](0044-phase-routing-and-token-economy.md)) only runs in
initialized repositories, so nothing later in the session corrected that.

## Decision

- In an uninitialized repository, the `SessionStart` guidance tells the agent to ask the
  user once, before the first code change of the session, whether to use Paved.
- On yes, the agent runs the init command and continues the request through Paved. On
  "not now", it works directly and does not ask again in that session.
- Questions, investigation and operational tasks proceed without the question.
- Initialization still requires the user's explicit yes; the hook neither initializes
  nor stores the answer. Broken and initialized repositories keep their current guidance.

## Consequences

Users who installed the plugin are offered Paved where they work, without Paved writing
anything to a repository on its own. The hook stays stateless: the "not now" answer
lives in the conversation, so a new session asks again, and adherence after compaction
depends on the summary keeping the answer. The guidance stays within the existing size
budget.

## Alternatives considered

- **Initialize automatically.** Removes the question, but writes state to a repository
  without consent, which the lifecycle contract forbids.
- **Remember a permanent decline per repository.** Avoids repeated questions, but needs
  a user-level state file and a CLI command; a per-session answer is enough for now.
- **Ask at session start.** Interrupts sessions that never change code.

## References

- [Hook handler](../../integrations/shared/prompt-submit-hook.mjs)
- [Hook tests](../../tests/integrations/prompt-submit-hook.test.ts)
- [Repository lifecycle](../concepts/repository-lifecycle.md)
- [ADR 0044](0044-phase-routing-and-token-economy.md)
