# ADR 0037: Session-scoped prompt guidance

- **Status:** Accepted
- **Date:** 2026-10-05
- **Amends:** [0031](0031-prompt-aware-plugin-hooks.md)

## Context

ADR 0031 adds Paved routing guidance to every prompt in an initialized repository. The
hosts keep that context in the conversation, so each turn adds the same text again: about
220 tokens per prompt, which grows with the length of the session. The guidance is needed
once per session, after `paved init` in an open session, and again when compaction or
clear drops earlier context.

Codex and Claude Code both pass `session_id` to hooks and support a `SessionStart` hook
whose matcher can select `compact` and `clear`.

## Decision

- The `UserPromptSubmit` hook adds the guidance only the first time in each session for
  each repository. It records this as an empty file under `paved-hook-sessions/` in the
  system temporary directory, named by the SHA-256 of the session id and the repository
  path, and created exclusively so concurrent prompts add it once.
- A `SessionStart` hook with the matcher `compact|clear` runs the same handler, which adds
  the guidance again for an initialized repository.
- Without a session id, or when the marker cannot be written, the guidance is added as
  before. Losing a marker can only repeat the guidance, never drop it.

## Consequences

- A session pays for the guidance once, plus once per compaction or clear.
- The hook now writes an empty marker file. It still never stores, transmits or logs
  prompt text, and the marker does not reveal the session id or the path.
- Markers are left for the operating system to clean with the temporary directory.

## Alternatives considered

- **Only a `SessionStart` hook.** Rejected: it does not fire after `paved init` in a
  session that is already open, which is the case ADR 0031 exists for.
- **Shorter guidance on every prompt.** Rejected: it still grows with the session.

## References

- [Hook handler](../../integrations/shared/prompt-submit-hook.mjs)
- [Hook configuration](../../integrations/shared/hooks.json)
- [Hook tests](../../tests/integrations/prompt-submit-hook.test.ts)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
