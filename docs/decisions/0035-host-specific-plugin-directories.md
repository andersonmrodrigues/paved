# ADR 0035: Host-specific plugin directories

- **Status:** Accepted
- **Date:** 2026-10-02
- **Amends:** [0034](0034-unpacked-plugin-runtime.md)

## Context

ADR 0034 ships one plugin directory with the runtime unpacked, its `node_modules/`
included, for every host. That directory has about 1,400 files, two of them over
256 KiB. Claude's plugin directory accepts at most 512 files of under 256 KiB each, and
reports a top-level `bin/` as not installable on claude.ai. OpenAI's plugin directory
takes a ZIP without lifecycle hooks, and needs listing fields (a short description of
up to 30 characters, a logo and a composer icon) that the plugin did not have.

Claude Code installs a plugin's npm dependencies itself when the plugin root holds a
`package.json` and a `package-lock.json`, with `--ignore-scripts` and the registry
packages pinned by the lockfile.

## Decision

- `npm run build:plugin` generates two directories from the same packed runtime:
  - `plugins/paved/` for Codex and Cursor, with the runtime's dependencies bundled as
    before, the OpenAI listing fields, and the icon under `assets/`;
  - `plugins/claude/paved/` for Claude Code, with the runtime without `node_modules/`,
    and a root `package.json` and `package-lock.json` that pin exactly the bundled
    dependencies, taken from the repository lock.
- `.claude-plugin/marketplace.json` lists `plugins/claude/paved`. The Codex and Cursor
  marketplaces keep listing `plugins/paved`.
- The launcher moves from `bin/` to `scripts/` in both directories. Skills in
  `plugins/paved/` name the launcher without a host variable.
- The Claude launcher config has `dependencies: ".."`. The launcher copies the runtime
  into staging, then adds each package the lockfile lists. It takes them from the
  `node_modules/` that Claude Code installed. When they are missing, it runs
  `npm ci --ignore-scripts` from the lockfile in a scratch directory. It then checks
  the whole tree against the same SHA-512 integrity as the bundled runtime. Both
  directories therefore pin and activate the same runtime, and `paved.lock` is
  unchanged.
- Provenance moves out of the plugin directories, to `plugins/provenance/`.
- `npm run package:openai` builds `dist/paved-openai-<version>.zip` from
  `plugins/paved/` without `hooks/` and `.cursor-plugin/`. CI uploads it as an artifact.

## Consequences

- The Claude plugin has about 440 files, each under 256 KiB except the icon. Claude's
  review still holds a plugin that installs dependencies from a lockfile, which is a
  review, not a rejection.
- Activation from the Claude plugin needs no network when Claude Code installed the
  dependencies. The `npm ci` fallback needs the registry, and what it installs is
  verified like everything else.
- A host-installed dependency that differs from the lockfile fails the integrity check,
  and the runtime is not activated.
- Plugins installed under ADR 0034 used `bin/paved.mjs`. Updating the plugin replaces
  the directory, and project state does not reference the launcher path.

## Alternatives considered

- **Bundle the runtime into one file.** Rejected: the result is over 256 KiB and is
  packed code, which Claude's directory review does not accept.
- **One directory for every host without `node_modules/`.** Rejected: Codex and Cursor
  do not install plugin dependencies, so activation would always need the registry.
- **Download the runtime on first use.** Rejected for the reasons in ADR 0026.

## References

- [Plugin build](../../plugins/build.ts)
- [OpenAI package](../../plugins/package-openai.ts)
- [Launcher](../../integrations/shared/bootstrap.mjs)
- [Generated plugin tests](../../tests/plugins/package.test.ts)
