# `paved update`

Refresh a consumer's local lock and generated output after the configured local Core or
local adapters change. Remote version resolution is not supported yet; `update` only
uses files available in this Core checkout.

## Behavior

1. **Preflight.** Validate `.paved/manifest.yaml` and require a valid existing
   `.paved/paved.lock`.
2. **Local compatibility check.** Confirm the local Core version satisfies `paved.core`
   and all selected adapters resolve from the local Core with compatible ranges.
3. **Plan local digest changes.** Compare the lock against the local Core, resolved
   adapters, and locked generator contracts using the same digest inputs as init and
   generation.
4. **Safe generation.** If a locked generator contract changed, run that generator
   through the safe generator runtime. Human-edited or untrusted generated output becomes
   a proposal/conflict and is not overwritten.
5. **Lock write.** Write `.paved/paved.lock` only after compatibility preflight and any
   required safe generation complete without blocking diagnostics.

## Options

`--dry-run`, `--json`, `--project <dir>`.

`--adapter`, remote selectors such as `--to`, migrations and override confirmation flags
are not supported by the current local-only implementation.

## Writes

`.paved/paved.lock` after successful preflight, plus `.paved/project/` and
`.paved/generated/` only through the existing safe generator runtime when locked
generator contracts changed. `--dry-run` writes nothing.

`update` never changes `.paved/manifest.yaml`, project-owned files, application source,
`AGENTS.md`, override files, or any path outside the configured consumer `.paved/`
layout.
