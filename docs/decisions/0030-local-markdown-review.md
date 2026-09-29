# 0030. Local Markdown review for plans and specs

- **Status:** Accepted
- **Date:** 2026-09-29

## Context

Workflow planning already requires a human approval record tied to the SHA-256 of a
plan file. A link to a raw Markdown file gives the reviewer no way to comment on a
specific passage while the agent is waiting. Codex and Claude Code expose lifecycle
hooks, but those hooks do not provide a shared channel that pushes arbitrary browser
comments into an already active agent turn. Codex app-server can drive a thread only
when Paved owns that app-server client; Claude Code has a separate programmatic API.

## Decision

Paved runs a loopback-only preview from its existing Node runtime. It renders Markdown
with HTML disabled and serves a browser UI with selected-text comments. The browser
stores comments in a schema-validated disposable `PreviewReview` document under
`.paved/generated/previews/`. A bounded `paved preview wait` command lets either agent
receive new comments while it keeps its review turn active. After editing the file,
the agent refreshes the workflow's plan hash and marks addressed comments resolved.
Only the browser's Approve action writes the human approval record. Approval requires
no open comments and binds to the current file hash and, when linked to a workflow,
its pending approval request. The workflow can issue a fresh request when review
changes the plan, preserving the same run. Standalone specs retain their approval in
the review document.

The server binds to `127.0.0.1` on an ephemeral port and requires a random session
token. Browser writes check the origin; response headers disable referrer leakage and
external scripts. This is a same-user local review channel, with the same identity
limit already documented for workflow approval files.

## Consequences

- Codex and Claude Code use one agent-neutral CLI protocol; neither needs a private
  event API or a Python installation.
- An agent needs to stay in the review loop for comments to receive an immediate
  response. If its turn ends, it can resume from the stored review revision.
- Comment anchors retain the selected quote, surrounding text, rendered-text offset
  and source hash. The sidebar keeps comments visible even when edits move their text.
- A browser approval of an older file hash is rejected, and a changed workflow plan
  needs a new approval request before approval succeeds.

## Alternatives considered

- **Python server:** adds a second runtime dependency to the pinned Node package.
- **Lifecycle hooks as a listener:** they run at agent lifecycle boundaries, not when
  a reviewer posts an arbitrary browser comment.
- **Direct app-server and Claude session control:** would require Paved to own both
  agent sessions and separate provider-specific transports.

## References

- [Workflow state](../concepts/workflow-state.md)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide)
