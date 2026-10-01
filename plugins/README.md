# Plugins

This component distributes Paved as one plugin for Cursor, Codex and Claude Code.

- [`plugin-source.json`](plugin-source.json) is the only authored plugin identity: name,
  version, description and presentation metadata. [`icon.png`](icon.png) is the listing
  icon, copied to `paved/.claude-plugin/icon.png`.
- [`build.ts`](build.ts) builds the runtime artifact and projects the Core into the plugin.
- `paved/` is the generated, installable plugin. Never edit it by hand; run
  `npm run build:plugin` and commit the result. `npm run check:plugin` and the test suite
  fail when it differs from what the build produces.

The plugin is a distribution and invocation layer. Its `bin/paved.mjs` launcher is
[`integrations/shared/bootstrap.mjs`](../integrations/shared/bootstrap.mjs), its skills are
rendered from `core/skills/` and the shared command catalog, and its runtime is the
`paved-core` package packed from this repository with its dependencies bundled. Workflows,
Tools, verification, lifecycle and provenance stay in that runtime.

The repository-backed marketplaces that list the plugin are
`.agents/plugins/marketplace.json` (Codex), `.claude-plugin/marketplace.json`
(Claude Code) and `.cursor-plugin/marketplace.json` (Cursor) at the repository root.
The Cursor-specific manifest disables hook discovery so Cursor installs the skills
without the shared Codex/Claude prompt hook. Installation is documented in
`docs/getting-started/installing-the-plugin.md`.
