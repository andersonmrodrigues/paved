# ADR 0033: Comment-only preview of files and folders

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** [0030](0030-local-markdown-review.md)

## Context

ADR 0030 reviewed one Markdown file at a time and made the browser's Approve button the
only way to record a plan approval. Reviews often span several documents: an epic and
its tasks, a plan with specs. Opening one preview per file loses the overview and makes
the agent wait on several reviews. Reviewers also could not tell whether a comment had
reached the agent, and approving in the browser duplicated a decision users already
express in the conversation.

## Decision

- `paved preview` takes a Markdown file or a folder. A folder reviews its Markdown files
  recursively, in path order, skipping hidden directories, dependency folders and
  symbolic links, up to 200 files; the list is rescanned while the review runs.
- One review per target holds every comment; each comment names its document. One
  `wait` cursor covers the whole target.
- A comment moves through `open` (saved), `received` (handed to the agent by `wait`),
  `working` (`paved preview working`) and `resolved` (`paved preview resolve`, with an
  optional `--reply` shown to the reviewer).
- When the agent is not watching, or a comment stays unreceived for 30 seconds, the
  page offers a prompt with the pending comments to copy into any agent's terminal.
- The preview approves nothing and has no workflow binding. The review ends when the
  user says so in the conversation.
- A plan is approved in the conversation. After an explicit yes, the agent runs the
  workflow with `--run <id> --approve`, which writes the approval record for the current
  plan digest under the local user name (never a name reserved for automation) and
  resumes. It refuses when no approval was requested or the plan changed since.
- Reviews written in the previous format are read as single-file reviews; their
  approval is dropped, since previews are disposable.

## Consequences

- An epic, or a plan with its tasks, is reviewed in one page and one agent loop.
- Reviewers see whether the agent has the comment and what it changed.
- Approval integrity now rests on the agent approving only after an explicit yes, not
  on a separate browser channel. This matches the same-user limit ADR 0030 already
  recorded: an agent with filesystem access could always write the approval file.
- Skills that used browser approval as consent now ask in the conversation.

## Alternatives considered

- **Keep browser approval for workflow plans.** Rejected by the maintainers: one place to
  decide, the conversation, is simpler than two.
- **A folder as a set of per-file reviews.** Rejected: several cursors to merge, and a
  file could belong to two reviews.
- **Concatenate the folder into one document.** Rejected: loses navigation and anchors
  per file.

## References

- [0030](0030-local-markdown-review.md)
- `cli/lib/preview-review.ts`, `cli/lib/preview-server.ts`, `cli/commands/preview.ts`
