# ADR 0034: Unpacked plugin runtime

- **Status:** Accepted
- **Date:** 2026-10-01
- **Amends:** [0026](0026-native-plugin-distribution.md)

## Context

ADR 0026 bundled the `paved-core` runtime in the plugin as an npm tarball. Claude's
plugin directory validates every submitted file and holds for manual review any archive
it cannot inspect, so the tarball blocked the plugin's listing. Readable files are
also easier for any reviewer, human or automated, to audit than a compressed artifact.

## Decision

- `npm run build:plugin` still packs the Core with `npm pack`, then unpacks the result
  into `plugins/paved/runtime/paved-core/`, bundled dependencies included. The plugin
  ships no archive.
- The runtime is pinned by a SHA-512 over its sorted `path\0sha256` file lines. The
  value has the lock's existing `integrity` format, so `paved.lock` and
  `selection.json` are unchanged.
- `bin/bootstrap.json` names the directory in `runtime` instead of `tarball`; a config
  with both is invalid. The launcher copies the directory into staging, verifies the
  copy (integrity, no links, no special bits, no non-JavaScript executables) and
  activates it under its content digest. npm does not run on this path.
- The local tarball and registry paths stay for project-local projections and locks
  that pin a runtime the plugin does not bundle.

## Consequences

- Every file in the plugin is text that a directory review can read.
- The repository carries about 1,300 generated runtime files (about 9 MB) instead of
  a 1.5 MB tarball. `.gitattributes` marks them generated, and `.gitignore` re-includes
  the bundled `node_modules/`.
- Projects pinned to a tarball-era runtime keep it; a plugin with a newer runtime
  reports the update, and `update` adopts it as before.
- Activation from the plugin no longer depends on npm being installed.

## Alternatives considered

- **Keep the tarball and explain it to reviewers.** Rejected: it leaves the listing on
  a manual hold and the artifact unreadable.
- **Download the runtime on first use.** Rejected for the reasons in ADR 0026, and a
  download is itself held by the directory review.
- **Track only a tree digest instead of per-file provenance.** Rejected: per-file
  digests keep the existing drift and hand-edit protection of the build.

## References

- [Plugin build](../../plugins/build.ts)
- [Launcher](../../integrations/shared/bootstrap.mjs)
- [Launcher failure modes](../../tests/plugins/failure-modes.test.ts)
