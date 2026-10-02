# Security policy

## Supported versions

The first tagged release has not yet been published. Until then, report
vulnerabilities against the default branch. After the first release, the latest
stable release line will receive security fixes; support for older lines will be
announced with their release policy.

## Reporting a vulnerability

Please report security issues privately to the maintainers before opening a public
issue or pull request. Include as much detail as possible about the impact,
affected files and reproduction steps.

Do not disclose a vulnerability publicly until a fix is available or a planned
mitigation is communicated.

## Security boundaries

Paved intentionally enforces boundaries between:

- Core behavior and consumer-owned project state
- generated output and human-owned files
- explicit tool contracts and concrete executable implementations
- agent integrations and canonical Core logic

The CLI does not grant arbitrary shell access beyond the declared Tool and
verification implementations. Unsafe or unapproved behavior must be blocked by
normal contract checks.

## Secret handling

- Never commit credentials, tokens, secrets or personal developer configuration.
- Treat generated evidence and diagnostic output as potentially sensitive.
- Avoid exposing environment details in user-facing errors unless required for a
  clear remediation.

## Filesystem safety

- Writes are constrained to the consumer `.paved/` layout and other approved
  generation paths.
- Atomic writes and ownership-safe update flows are used when mutating consumer
  state.
- Symlinks, generated state and disposable output must not be treated as source
  of truth for application code.

## Agent integration safety

Agent integrations are thin projections. They must not silently upgrade Core,
modify consumer source outside the documented contract, or add hidden execution
capabilities.

## Plugin distribution

The Codex and Claude Code plugin in `plugins/paved/` is generated and committed; it
is installed through each agent's native plugin installation from this repository.

- No install hooks, MCP server or downloaded install script. Code runs only when a
  Paved command is invoked.
- The bundled runtime ships unpacked, so every file can be reviewed. It is pinned by
  a SHA-512 over its file digests in `bin/bootstrap.json` and in `provenance.json`,
  which also records a digest for every plugin file. The test suite fails when the
  committed plugin differs from a fresh build.
- The launcher verifies the copy it activates, not the source, and accepts only
  regular files: links, special permission bits and non-JavaScript executables are
  refused, and no npm or install script runs. A registry or local tarball artifact
  is checked entry by entry before extraction (no links, absolute paths or `..`
  segments) and installed with `--ignore-scripts`; resolved dependencies must come
  from the artifact itself.
- The launcher writes only under the consumer's `.paved/runtime/` and refuses the
  plugin directory and the Core checkout as consumers. A different runtime is
  activated only by `runtime upgrade`, with rollback.
- Integrity pins protect against tampering in transit and at rest; they do not
  protect against a compromised repository. Pin a reviewed ref (`--ref`) when that
  matters.
