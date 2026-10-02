# `paved tool` command contract

The command UX is specified here; no executable Tool runner is implemented in this
phase. `cli/lib/tools.ts` supplies discovery, resolution, validation, policy and
evidence-capture functions for the future runner.

- `paved tool list [--capability <name>] [--environment <kind>] [--json]` lists Tool
  contracts with safety, permissions, input/output shape, source and availability.
  Discovery never grants execution.
- `paved tool inspect <id> [--json]` shows the effective Tool contract, compatible
  implementation candidates, policy restrictions and provenance of any override.
- `paved tool validate <id|path> [--json]` checks schema, references, implementation
  compatibility, input bindings, safety and override invariants without execution.
- `paved tool doctor [--json]` reports missing or obsolete bindings, duplicate
  capabilities, incompatible versions, unsafe policies and recurring failures.

A future `paved tool run <id>` must resolve and authorize before execution. It must
validate typed inputs, evaluate preconditions, honor timeouts and cancellation, spawn an
executable with an argv vector and no shell, sanitize output, validate structured
fields, and capture revision-bound results. For destructive or high-impact Tools it must
obtain an authenticated human approval per invocation. CI without approval fails closed.

Results follow the CLI exit codes in [CLI](../../README.md): 0 success, 1 validation
or Tool failure, 2 usage error, 3 environment failure. `--json` is available for
machine consumers. The future runner writes only disposable execution records and
Evidence artifacts allowed by the consumer layout.
