# Prompt-Aware Paved Plugin Hooks

- **Status:** Approved direction; spec awaiting review
- **Date:** 2026-09-29
- **Scope:** Keep Codex and Claude Code aware of Paved on every user turn in an initialized consumer repository.

## Problem

Paved skills are task-scoped: an agent may not activate them for a plain-language
request such as “fix this error.” `paved init` maintains a Paved block in the root
`AGENTS.md`, but host instruction files are loaded differently and may have been read
before initialization. The active session therefore has no reliable way to reconsider
Paved on the next user message.

Codex and Claude Code both support a `UserPromptSubmit` hook that can add context to
each submitted prompt. Their plugin hook configuration and hook trust behavior are
host-specific, but their input and context-injection needs are compatible for this use.

## Goals

- Add a lightweight Paved routing reminder to every user turn in an initialized Paved
  consumer when the plugin hook is enabled and trusted.
- Make the hook effective on the next prompt after `paved init`, including in the
  session that ran initialization.
- Reuse one implementation for Codex and Claude Code.
- Keep the current `AGENTS.md` managed block as a persistent fallback.
- Let the host and model answer ordinary conversation without forcing Paved workflows
  onto unrelated or read-only requests.
- Preserve the existing Paved runtime as the authority for command availability,
  project context, workflow state, approvals, tools and verification.

## Non-goals

- Blocking or rewriting user prompts.
- Blocking file writes or tool calls that do not have an active Paved workflow run.
- Running `paved status`, tests, or other CLI operations on every prompt.
- Adding a `CLAUDE.md` or configuration for unsupported hosts in this release.
- Guaranteeing Paved behavior when the plugin or its hooks are disabled, untrusted,
  unavailable, or unsupported by the host.

## Design

### Shared `UserPromptSubmit` hook

Package one hook handler and one hook manifest in the generated plugin. Both Codex and
Claude Code run the handler before processing a user prompt. The handler reads the
hook's JSON input from stdin and uses its `cwd` to locate the nearest consumer root,
following the same boundary rule as the plugin launcher: stop at the first ancestor
with `.paved/manifest.yaml` or `.git`.

The hook emits a valid `additionalContext` result only when that root has both
`.paved/manifest.yaml` and `.paved/paved.lock`. Otherwise it exits successfully without
output. This allows the hook to be installed globally through the plugin but remain
inactive in unrelated and not-yet-initialized repositories. It does not parse project
configuration, start the Core runtime, or invoke a shell command from the repository.

The hook uses the shared plugin-root environment variable supported by Codex and Claude
Code plugin hooks. It uses only Node.js built-ins, which are already required by the
Paved launcher.

### Injected routing policy

Keep the injected instruction short and stable:

- For repository changes, testing, planning or review, consult Paved state and use the
  matching available Paved command/workflow.
- For repository-specific questions, consult only the relevant Paved context and answer
  directly; do not create a workflow when none is needed.
- For requests unrelated to the repository, proceed normally without invoking Paved.
- Respect explicit user direction. If a required Paved command is unavailable, explain
  the blocker rather than silently substituting an undeclared process.

The hook does not choose a workflow or run commands. The agent uses existing skill and
command contracts; the runtime determines availability and applies its gates.

### Persistent fallback and user ownership

Keep `core/templates/AGENTS.md` and `ensureAgentsBlock` behavior unchanged. The managed
block remains a persistent instruction for Codex and other hosts that load `AGENTS.md`.
This release does not add a Claude-specific instruction-file fallback: per-prompt
routing in Claude Code depends on the plugin hook being enabled and trusted. The hook
covers the already-open Codex or Claude Code session on its next prompt.

Do not create or overwrite `CLAUDE.md`, `.claude/settings.json`, or project hook files.
The installable plugin owns its packaged hook configuration; consumer repositories do
not gain host-specific hooks during `paved init`.

### Failure behavior and trust

The hook is advisory and must fail open: malformed input, missing fields, missing
project state, or an internal exception produces no injected context and must not block
the user's message. No prompt text is persisted, transmitted, or logged by the hook.

Codex requires the user to review and trust plugin-bundled hooks. Claude Code applies
its workspace trust rules to plugin hooks. Installation alone therefore does not make
the hook unconditionally active. The plugin documentation must explain how to review
and enable the hook and must not claim hard enforcement.

## Packaging and versioning

- Add the shared hook handler and `hooks/hooks.json` to the plugin build inputs.
- Ensure both generated plugin manifests discover the hook without replacing unrelated
  host-specific manifest settings.
- Include both files in plugin provenance and drift checks.
- Increment plugin and Core versions as a compatible Core feature release.
- Rebuild and validate the generated plugin, then publish using `release.sh` and tag the
  release.

## Verification

- Unit coverage proves the handler emits guidance only for an initialized Paved
  consumer, finds the nearest repository boundary, and exits without blocking on
  unrelated, malformed, or incomplete state.
- Packaging tests prove Codex and Claude Code manifests discover the same handler and
  that the hook files are covered by generated provenance.
- A clean-room plugin test verifies the hook is present in the installed artifact.
- Existing `AGENTS.md` ownership tests continue to prove that human-authored text is
  preserved.
- `npm run build:plugin`, `npm run check:plugin`, and `npm run check` pass before release.

## Acceptance criteria

1. A trusted Paved plugin injects routing guidance before each prompt in an initialized
   consumer for both Codex and Claude Code.
2. After `paved init` creates the manifest and lock, the next prompt in that same
   session receives the guidance.
3. A repository without complete Paved state receives no Paved-specific injected
   context and is not blocked.
4. Repository changes are directed to the existing Paved commands; read-only questions
   and unrelated conversation do not trigger unnecessary workflows.
5. The hook never executes Paved commands, modifies repository files, blocks a prompt,
   or records/transmits prompt text.
6. Existing `AGENTS.md` behavior remains intact, and no consumer-owned agent file is
   overwritten or newly required.
7. The generated plugin passes drift, full Core checks and clean-room packaging
   verification, and the release is tagged.

## References

- [OpenAI plugin hooks](https://developers.openai.com/plugins/build/plugins)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- Existing managed block: `core/templates/AGENTS.md`
- Existing block writer: `cli/lib/agents-block.ts`
- Generated plugin pipeline: `plugins/build.ts`

The implementation plan will add an ADR that amends [ADR 0024](../../decisions/0024-agent-integration-projections.md)
with the per-prompt hook, trust and fallback contract.
