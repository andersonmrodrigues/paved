# Security policy

## Supported versions

Paved currently supports the 1.0.0 release line and later. Security fixes are
prioritized for the current release and the latest stable maintenance line.

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
