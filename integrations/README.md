# Agent integrations

Agent integrations are thin projections of Paved Core. They package canonical
`SKILL.md` documents and agent-native command prompts from one shared semantic
catalog, and invoke the existing `paved --json` CLI dispatcher. They must not
implement lifecycle, verification, generators, adapters, provenance or
arbitrary command execution.

The Codex projection installs canonical skills and `$paved-<command>` command
skills under `.agents/skills/`. The Claude Code projection installs canonical
skills and `/paved:<command>` project commands under `.claude/commands/paved/`.
Both use the same command contract. `paved agent commands --json` discovers
lifecycle-aware availability; `paved agent command <name> --json` resolves one
contract. The existing `paved agent list`, `status`, `validate`, `install`,
`update` and `uninstall` operations remain supported.

Each projection includes `bootstrap.mjs` and a version-pinned `bootstrap.json`.
The launcher reads `.paved/paved.lock` when present, verifies the selected
tarball and installed content, and invokes the packaged CLI under
`.paved/runtime/`. It refuses mismatched or corrupt state. The consumer's
`.paved/` state remains authoritative; generated agent files are disposable
Paved-owned projections and are never application source. `paved agent install`
can project both integrations from a packed artifact.

The installable plugin in `plugins/` reuses this layer: its skills are rendered by
`shared/projection.ts` from the same catalog, and its `scripts/paved.mjs` is
`shared/bootstrap.mjs` unchanged. Consumers normally install that plugin through
native plugin installation instead of committing a project-local projection.

For parallel implementation work, Paved Core provides a bounded delegation graph and
task/model policy, while execution remains host-native. Claude Code agents/sessions and
Codex collaboration/session tools are selected and started by the active host agent;
Paved neither calls provider APIs nor assumes a fixed model catalog. The runtime records
the actual host-reported model, effort and optional usage. If a host does not expose
per-task model selection, the agent follows that host's available routing behavior and
records what actually ran.

Claude Code and Codex load plugin-bundled lifecycle hooks from `shared/hooks.json`.
SessionStart supplies a short index and checks for plugin updates only when a pinned
runtime selection already exists. The update command is inert unless the user has
explicitly configured automatic updates; Paved never initializes a project from a
hook. Stop runs `verify --changed` synchronously and requests
continuation on failure. If Stop already continued the turn, it reports NOT VERIFIED
instead of blocking again, avoiding an infinite loop. Hook trust, host settings,
timeouts and interruptions can prevent execution; this is not a security boundary.

Cursor's plugin disables these hooks; other hosts have no claimed hook enforcement.
Use `paved verify --changed` explicitly there. Open tasks are listed, not selected:
pass `--task <slug>` explicitly when recording evidence for a particular task. The
Workbench hook only sends minimal activity to a running loopback dashboard. It does
not attach verification evidence. Git hooks, governed approvals and review gates are
not provided by these lifecycle hooks.

### Codex protocol evidence

The [official Codex hooks reference](https://developers.openai.com/codex/hooks)
(checked 2026-11-21) documents:

- [Plugin-bundled hooks](https://developers.openai.com/codex/hooks#plugin-bundled-hooks):
  default discovery at `hooks/hooks.json`, and `PLUGIN_ROOT` pointing to the installed
  plugin root. Plugin hooks require review and trust.
- [Common input fields](https://developers.openai.com/codex/hooks#common-input-fields):
  one JSON object on stdin, with string `cwd` and `hook_event_name`.
- [SessionStart](https://developers.openai.com/codex/hooks#sessionstart):
  `source` matching and `hookSpecificOutput.additionalContext`.
- [Stop](https://developers.openai.com/codex/hooks#stop):
  JSON stdout with `decision: "block"` and `reason` requests a continuation prompt;
  it does **not** reject the turn or guarantee completion prevention.

This confirms the documented protocol, not an end-to-end execution of the packaged
Paved plugin in a real Codex session. Local hook and projection tests simulate that
protocol. Older clients, disabled or untrusted hooks, managed-only settings and cloud
orchestration can omit these plugin command hooks. No enforcement is claimed there.
