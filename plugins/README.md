# Plugins

This component distributes Paved as one native plugin for Codex and Claude Code.

- [`plugin-source.json`](plugin-source.json) is the only authored plugin identity: name,
  version, description and presentation metadata.
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
`.agents/plugins/marketplace.json` (Codex) and `.claude-plugin/marketplace.json`
(Claude Code) at the repository root. Installation is documented in
`docs/getting-started/installing-the-plugin.md`.
