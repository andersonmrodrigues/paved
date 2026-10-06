# ADR 0038: Local workbench and hook activity

- **Status:** Accepted
- **Date:** 2026-10-05
- **Extends:** [0024](0024-agent-integration-projections.md), [0030](0030-local-markdown-review.md)

## Context

Paved records workflow runs in `.paved/generated/runs/`, but users otherwise inspect
progress through command output and individual documents. Claude Code and Codex both
provide plugin-bundled command hooks, with distinct event schemas and trust controls.
The dashboard should make current work easier to follow without creating another source
of workflow truth, taking ownership of agent sessions, or changing human approval gates.

## Decision

- Add `paved workbench start|status|stop` as a local CLI experience, not an agent command.
- The Workbench reads and validates existing `WorkflowRun` records and serves a browser
  dashboard on `127.0.0.1` with an ephemeral port and random token. It displays run
  phases, status, pending human decisions and actionable next commands. It does not
  mutate runs, answer decisions or approve plans.
- Plugin lifecycle hooks send a small event to the running Workbench only when the
  current repository is initialized and the server info exists. The payload contains the
  host, event name, optional tool name and SHA-256 session identifier. Prompt text,
  transcript paths and tool input/output are excluded. Activity is in-memory, bounded
  to 100 sessions and disappears when the server stops. Hook failures fail open.
- Keep the host hook definitions in the plugin projection and the dashboard in the
  packaged CLI. Claude Code and Codex retain their native event/configuration formats;
  the handler tolerates host event payload differences and uses only common fields.
- Do not use lifecycle hooks as a comment or approval channel. The existing local
  preview remains the review channel, and decisions remain in the conversation and
  existing Paved commands.

## Consequences

- Users can follow several Paved runs and see recent plugin activity in one local page.
- The dashboard works from durable Paved run state even when hooks are disabled,
  untrusted, unsupported or unavailable. Hook activity is intentionally ephemeral.
- The server follows the local preview's loopback/token security pattern. It is not
  protected against another process running as the same OS user, consistent with Paved's
  existing local approval and preview model.
- Hooks add a short asynchronous local request to common lifecycle events while the
  Workbench is active. They do not affect permission or continuation decisions.

## Alternatives considered

- **Hooks as the workflow store:** rejected because host hook event sequences differ and
  hooks can be disabled or untrusted; the validated `WorkflowRun` is already durable.
- **A hosted dashboard or cross-repository service:** rejected because it would require
  remote state, authentication and a new privacy boundary.
- **Reuse the document preview as a dashboard:** rejected because preview has a specific
  review/comment lifecycle and should not become the workflow overview.
- **Make the dashboard approve plans or resolve decisions:** rejected because it would
  move existing human gates into a new protocol and create parallel approval behavior.

## References

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [ADR 0030: Local Markdown review](0030-local-markdown-review.md)
- [Workflow state](../concepts/workflow-state.md)
