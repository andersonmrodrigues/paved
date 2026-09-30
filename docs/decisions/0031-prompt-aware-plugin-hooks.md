# ADR 0031: Prompt-aware plugin hooks

- **Status:** Accepted
- **Date:** 2026-09-29
- **Extends:** [0024](0024-agent-integration-projections.md)

## Context

Paved's native skills are task-scoped, so a plain-language request may not activate
Paved even after the user initializes a repository in an already-open agent session.
Codex and Claude Code both provide plugin-bundled `UserPromptSubmit` hooks that can
add context to each submitted prompt. The hook must preserve Paved's role as an
advisory workflow and keep the runtime as the authority for command availability and
gates.

## Decision

The installable plugin bundles one shared Node.js handler and `hooks/hooks.json` for
Codex and Claude Code. The handler reads the event's `cwd`, finds the nearest ancestor
with `.paved/manifest.yaml` or `.git`, and emits
`hookSpecificOutput.hookEventName = "UserPromptSubmit"` with routing context only when
that root contains both `.paved/manifest.yaml` and `.paved/paved.lock`.

The context points repository changes, testing, planning, and review toward matching
Paved commands; writing, filling in, or reviewing tracker items toward the task
specification and task review skills; repository questions toward relevant context without creating a
workflow; unrelated requests to normal conversation; and unavailable commands to an
explicit blocker explanation. It respects explicit user direction.

The hook does not invoke the Paved CLI, execute repository commands, modify files,
block prompts, or persist, transmit, or log prompt text. Malformed input, missing state,
or internal errors exit successfully without output. Codex and Claude Code trust
controls determine whether a plugin hook runs. The existing managed `AGENTS.md` block
remains a fallback for hosts that load it; this decision adds no `CLAUDE.md`, project
hook configuration, or other consumer-owned agent file.

## Consequences

The plugin can remind both supported hosts about Paved on the next prompt after init in
the same session. The reminder is not enforcement and is absent when the hook is
disabled, untrusted, unavailable, or unsupported. The Core remains agent-neutral: the
host hook is shipped by the plugin and does not add host branches to Core runtime code.

## Alternatives considered

- Rely only on task-scoped commands and `AGENTS.md`: keeps the current integration
  surface but does not reliably refresh the active session after init.
- Add or overwrite `CLAUDE.md` or project-local hook settings: introduces another
  consumer-owned file and makes initialization host-specific.
- Run Paved status or workflow commands on every prompt: adds latency and performs
  unnecessary work for unrelated or conversational requests.

## References

- [OpenAI Codex plugin-bundled hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [ADR 0024: Agent integration projections](0024-agent-integration-projections.md)
- [Plugin installation](../getting-started/installing-the-plugin.md#keep-paved-in-context)
