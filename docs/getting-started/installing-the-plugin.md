# Installing the Paved plugin

Paved is installed as one native plugin for Cursor, Codex and Claude Code. This repository
is its own plugin marketplace: GitHub-backed marketplace distribution means each
agent reads the marketplace file committed at the repository root and installs the
generated plugin in [`plugins/paved/`](../../plugins/paved/) through its own
native plugin installation. Nothing is piped into a shell, installed globally, or added
to the application's dependencies.

> **Publication status:** Paved is not listed in the public Codex, Claude Code or Cursor
> plugin directories and `paved-core` is not published to npm. Installation works
> today from the GitHub repository as a marketplace source, as described below.

Requirements: Node.js 22.18 or later and npm on `PATH` (the launcher uses them to
activate the bundled runtime), plus Git for the marketplace clone.

## Install

### Codex

```bash
codex plugin marketplace add andersonmrodrigues/paved
codex plugin add paved@paved
```

To pin a branch or tag, add `--ref <ref>` to `marketplace add`.

### Claude Code

```bash
claude plugin marketplace add andersonmrodrigues/paved
claude plugin install paved@paved
```

Inside a Claude Code session the equivalent is `/plugin marketplace add
andersonmrodrigues/paved` followed by `/plugin install paved@paved`.

### Cursor

In Cursor, open **Customize → Plugins → From GitHub Repository**, enter
`https://github.com/andersonmrodrigues/paved`, import the Paved marketplace, then
install **Paved** at user or project scope. The repository's
`.cursor-plugin/marketplace.json` points to the generated plugin in `plugins/paved/`.
Cursor loads the Paved skills without enabling the shared Claude Code/Codex prompt hook;
invoke them manually by skill name, such as `/status` or `/feature`.

## Verify the installation

- Codex: start a session in a repository and ask for the skill list, or run
  `codex debug prompt-input hi` and look for `paved:init`, `paved:status` and the
  other `paved:*` skills.
- Claude Code: `claude plugin details paved` lists the plugin's skills; in a
  session, `/paved:` completes to the Paved commands.
- Cursor: open **Customize → Plugins** and confirm Paved is installed; invoke a skill
  with `/status` in Agent chat.

## Use it

Open the repository you want Paved to manage and invoke a command:

```text
Claude Code: /paved:init   /paved:status   /paved:plan   /paved:feature
Codex:       paved:init    paved:status    paved:plan    paved:feature   (as skills)
Cursor:      /init        /status         /plan         /feature
```

The first command activates the runtime. The plugin's launcher (`bin/paved.mjs`):

1. finds the consumer repository: `--project` if given, otherwise the nearest
   directory above the current one that holds `.paved/manifest.yaml` or `.git`.
   It refuses the plugin installation and the Paved Core source checkout;
2. verifies the bundled `paved-core` tarball against the SHA-512 integrity pinned
   in the plugin, and inspects every archive entry before extraction;
3. installs it offline under `.paved/runtime/` with install scripts disabled and
   no dependencies outside the artifact;
4. records the installed content digest, and checks it before every command.

`.paved/runtime/` ignores itself in Git. `init` records the runtime in
`.paved/paved.lock`, which is committed. After activation every command runs
offline from the verified local copy. See the
[agent command reference](../concepts/agent-commands.md) for all commands.

## Keep Paved in context

The plugin includes a `UserPromptSubmit` hook for Codex and Claude Code. On each
submitted prompt it checks the nearest repository boundary and adds short Paved routing
guidance only when both `.paved/manifest.yaml` and `.paved/paved.lock` exist. This also
covers the next prompt in the same session after `paved init` completes.

Review and trust the plugin's hook when Codex or Claude Code asks. Codex skips plugin
hooks until you review and trust their current definition; Claude Code applies its
workspace trust rules. Hook activation is advisory: it does not run Paved commands,
inspect prompt text, or change files. Invalid input, missing state, or hook errors fail
open and leave the prompt unaffected. If the hook is disabled, untrusted, or unsupported
by the host, the existing Paved skills and the `AGENTS.md` guidance remain available
where that host loads them.

## Update the plugin

- Codex: `codex plugin marketplace upgrade paved`, then `codex plugin add paved@paved`.
- Claude Code: `claude plugin marketplace update paved`, then
  `claude plugin update paved@paved`.

Updating the plugin never changes a repository's runtime by itself. The lock in
each repository stays authoritative; when the plugin carries a different runtime,
commands keep using the locked one and print a `PAVED_RUNTIME_UPDATE_AVAILABLE`
notice on stderr.

## Upgrade or roll back a repository's runtime

After updating the plugin, run `paved update` (the `paved:update` skill) in the
repository. When the plugin carries a newer runtime than `.paved/paved.lock` pins,
update verifies and activates it, rewrites the lock through the Core's transactional
update and keeps the previous state for rollback; `update --dry-run` only reports the
runtime it would adopt. The same or an older plugin runtime never changes the pin.

The launcher also exposes the runtime operations directly. Its path is `bin/paved.mjs` in the
installed plugin directory (Claude Code: `installPath` from
`claude plugin list --json`; Codex: under
`$CODEX_HOME/plugins/cache/paved/paved/<version>/`).

```bash
node <plugin>/bin/paved.mjs runtime status --json    # plugin, locked and active runtime
node <plugin>/bin/paved.mjs runtime upgrade --json   # verify, activate and update the lock
node <plugin>/bin/paved.mjs runtime rollback --json  # restore the previous runtime and lock
```

`runtime upgrade` (the path `update` uses) verifies the new runtime, activates it, and lets that runtime run
the Core's transactional `update`. If the update fails, the previous runtime stays
selected and the lock is unchanged. A successful upgrade keeps the previous lock
bytes and runtime selection so that `runtime rollback` can restore them exactly.
Commit the updated `.paved/paved.lock` once you have reviewed the change.

A repository initialized earlier with the direct CLI has a lock without a runtime
entry. The launcher reports `PAVED_RUNTIME_LOCK_MIGRATION_REQUIRED` for it and
changes nothing; `update` or `runtime upgrade` adopts the plugin's runtime through the same
transactional update, and `runtime rollback` restores the original lock.

## Remove

- Codex: `codex plugin remove paved@paved`, optionally
  `codex plugin marketplace remove paved`.
- Claude Code: `claude plugin uninstall paved@paved`, optionally
  `claude plugin marketplace remove paved`.

Removing the plugin leaves each repository's `.paved/` state in place.

## Reset a repository's runtime cache

`.paved/runtime/` is disposable. Delete it and run any command again; the
launcher reactivates the runtime pinned by `.paved/paved.lock` from the plugin's
bundled artifact when it matches, and refuses anything that does not match.

## Troubleshooting

Every launcher failure is a JSON result on stdout with one diagnostic code and a
next action:

| Code | Meaning |
| --- | --- |
| `PAVED_RUNTIME_PROJECT_INVALID` | No usable consumer repository, or it resolved to the plugin or the Core checkout. |
| `PAVED_RUNTIME_INTEGRITY_MISMATCH` | The artifact does not match its pinned SHA-512; nothing was installed. |
| `PAVED_RUNTIME_ARCHIVE_UNSAFE` / `_INVALID` | The artifact has unsafe entries (links, traversal) or is malformed. |
| `PAVED_RUNTIME_UNEXPECTED_EXECUTABLE` / `_DEPENDENCY` | The artifact contains unexpected executables or resolved outside dependencies. |
| `PAVED_RUNTIME_CORRUPT` | The installed runtime changed after activation; reset the runtime cache. |
| `PAVED_RUNTIME_LOCK_MISMATCH` / `_LOCK_INVALID` | The active runtime differs from, or cannot be read from, `.paved/paved.lock`. |
| `PAVED_RUNTIME_ACQUISITION_FAILED` | The locked runtime is not bundled with this plugin and could not be fetched. |
| `PAVED_RUNTIME_CONCURRENT_BOOTSTRAP` | Another activation is running. A lock left by a dead process is recovered automatically. |
| `PAVED_RUNTIME_UPGRADE_FAILED` / `_UPGRADE_CONFLICT` | The upgrade was refused and the previous state kept, or a rollback is still pending. |
| `PAVED_RUNTIME_IO_FAILED` | The launcher could not read or write `.paved/runtime/`. |

## Security

- The plugin contains no install-time hooks or MCP server. Codex and Claude Code
  clone the marketplace repository; the launcher runs only when you invoke a Paved
  command, and it reaches the npm registry only when a lock pins a runtime the
  plugin does not bundle, under the same integrity checks.
- The runtime artifact is pinned by SHA-512 in `bin/bootstrap.json` and recorded,
  with its content digest, in `provenance.json`. npm runs with `--ignore-scripts`.
- Archive entries must be regular files or directories under `package/`; links,
  absolute paths, `..` segments and special permission bits are refused.
- A different runtime is activated only by `update` (newer runtimes only) or `runtime upgrade`, never by other commands.
- The prompt hook reads the event's `cwd` and checks Paved state marker paths. It never
  stores, transmits, or logs the prompt; it emits routing guidance only for initialized
  repositories and exits successfully without output otherwise.

## Local development

Contributors can install their working copy instead of GitHub:

```bash
npm ci
npm run build:plugin                       # regenerate plugins/paved/
codex plugin marketplace add "$PWD"        # or: claude plugin marketplace add "$PWD"
```

Claude Code can also load the directory directly for one session with
`claude --plugin-dir ./plugins/paved`.
