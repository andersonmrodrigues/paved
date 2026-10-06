# Plugins

This component distributes Paved as a plugin for Cursor, Codex and Claude Code.

- [`plugin-source.json`](plugin-source.json) is the only authored plugin identity: name,
  version, descriptions and presentation metadata. [`icon.png`](icon.png) is the listing
  icon, copied to `paved/assets/icon.png` and `claude/paved/.claude-plugin/icon.png`.
- [`build.ts`](build.ts) builds the runtime artifact and projects the Core into two
  generated, installable plugins. Never edit them by hand; run `npm run build:plugin` and
  commit the result. `npm run check:plugin` and the test suite fail when they differ from
  what the build produces.
  - `paved/` is for Codex and Cursor. Its runtime carries its dependencies in
    `node_modules/`.
  - `claude/paved/` is for Claude Code. Its runtime has no `node_modules/`; the root
    `package-lock.json` pins those dependencies, and Claude Code installs them.
- [`provenance/`](provenance/) records the digest of every generated file per plugin.
- [`package-openai.ts`](package-openai.ts) (`npm run package:openai`) packs `paved/` without
  hooks into the ZIP that OpenAI's plugin directory accepts.

The plugins are a distribution and invocation layer. Their `scripts/paved.mjs` launcher is
[`integrations/shared/bootstrap.mjs`](../integrations/shared/bootstrap.mjs), their skills
are rendered from `core/skills/` and the shared command catalog, and their runtime is the
`paved-core` package packed from this repository and unpacked into
`runtime/paved-core/` so plugin directories can review every file. Both plugins pin the
same runtime integrity. Workflows, Tools, verification, lifecycle and provenance stay in
that runtime (ADR 0035).

The repository-backed marketplaces that list the plugin are
`.agents/plugins/marketplace.json` (Codex), `.claude-plugin/marketplace.json`
(Claude Code) and `.cursor-plugin/marketplace.json` (Cursor) at the repository root.
The Cursor-specific manifest disables hook discovery so Cursor installs the skills
without the shared prompt-routing or Workbench activity hooks. Installation is documented in
`docs/getting-started/installing-the-plugin.md`.

Claude Code and Codex load the plugin-bundled hooks from `hooks/hooks.json`. The
Workbench activity hook is optional at runtime: it sends small lifecycle events only
while `paved workbench start` is running. The local dashboard reads validated workflow
runs from the repository and keeps hook activity in memory.
