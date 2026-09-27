# Tools architecture review

Status: architecture and contracts established; **not production-ready**. This review
covers the Paved Core only and uses synthetic fixtures. It does not analyze a consumer
repository and does not execute project-specific commands.

## Architecture

A Tool is a versioned capability contract. `ToolImplementation` is a separately versioned
binding supplied by Core, an adapter or a project. A Tool declares structured inputs and
outputs, permissions, preconditions, environments, side effects, safety, idempotency,
bounded timeouts/retries, error vocabulary, availability and evidence capture. A binding
declares its Tool version range and environment and uses executable plus argv elements;
inputs are never interpolated through a shell.

The Tool catalog and qualified document references serve as the registry. Discovery
shows capability and availability but grants no permission. Deterministic resolution
prefers a binding in the Tool's namespace, can use one compatible adapter binding for
an abstract Core capability, and requires an explicit override to select a project
binding for inherited Tools. Missing or ambiguous implementations block execution.

| Concern | Contract or enforcement |
|---|---|
| Tool capability | [`tool.schema.yaml`](../../schemas/tool.schema.yaml) |
| Implementation binding | [`tool-implementation.schema.yaml`](../../schemas/tool-implementation.schema.yaml) |
| Policy overrides | [`override.schema.yaml`](../../schemas/override.schema.yaml) |
| Discovery, validation, resolution, authorization and capture | [`cli/lib/tools.ts`](../../cli/lib/tools.ts) |
| Architecture decisions | [ADR 0017](../decisions/0017-tool-capability-and-resolution.md), [ADR 0018](../decisions/0018-tool-safety-and-evidence.md) |

Tools provide capabilities; Skills define engineering behavior; Workflows orchestrate;
Rules constrain; Verification defines correctness checks; Evidence records observations.
Tools do not compose other Tools into an orchestration system.

## Safety, permissions and failures

The safety classes are `read-only`, `safe-mutation`, `destructive` and `high-impact`.
Read-only contracts cannot declare side effects or write permissions. Safe mutations are
limited by default to local, CI and ephemeral environments. Destructive and high-impact
operations require a separate human approval per invocation and cannot retry. Execution
also requires the declared permissions and all preconditions. Tool overrides can only
restrict environments, timeouts or attempts, require approval, disable a Tool, or select
an explicit compatible binding.

Retries are bounded and limited to idempotent read-only/safe-mutation operations for
transient or environment errors. Partial execution remains visible. The contract has
typed error categories for invalid input, failed precondition, unavailable dependency,
permission denial, timeout, execution/environment/transient failure, policy violation,
unsupported capability, missing implementation, malformed output, partial execution and
unavailable evidence. Errors and outputs must be sanitized; secrets do not belong in
Tool contracts or stored records.

Unavailable Tool, unresolved/ambiguous binding, unmet precondition, denied permission,
incompatible override, timeout, malformed output or evidence capture failure never
silently becomes success. The capture library requires an immutable revision, actual
Tool contract version, implementation identity, environment, times and sanitized digests.
CI records require a run URL. An agent-authored record remains marked as `agent`.

## Verification and Evidence

Checks reference Tool capability ids, never executable commands. The runner should
authorize, resolve, validate input, execute with a timeout, validate structured output
and capture sanitized observations and artifacts. The capture helper maps a result to
the Phase 06 Evidence `CheckResult`; execution success alone is insufficient to pass a
Check whose expected result was not observed. Revision, environment, recorder and output
digest are carried into the existing Evidence model; Tools create no alternate Evidence
format. Completion remains the Evidence assessor's responsibility.

## Catalog and validation

Core defines generic capability contracts for repository, runtime/process, testing,
database reads, observability, infrastructure and browser interaction. It does not bind
language-, framework-, database-, cloud- or CI-specific commands. A small set of Core
bindings supports generic Git inspection and Paved validation/diagnostics. Other
capabilities remain planned or unavailable until an adapter/project supplies a binding.

Schemas and synthetic tests cover contract validity, safety invariants, permissions,
preconditions, input/output validation, version compatibility, resolution, explicit
overrides, environment boundaries, approval, retry limits, redaction, CI provenance and
Evidence conversion. Core reference tests validate declared Tool and implementation
documents. The repository's `npm run check` is the final suite.

## Unresolved decisions and next work

- Implement the CLI process runner with isolation, cancellation, platform-specific argv
  handling, bounded output and artifact storage.
- Authenticate human approvals and runner/CI recorder identities cryptographically or
  through a trusted execution boundary; the present library cannot establish identity.
- Decide how environment facts, dependency digests, revision/worktree state and artifact
  checksums are captured and verified end-to-end.
- Tighten structured output schemas beyond top-level field presence where consumers need
  typed values, while keeping Core technology-neutral.
- Define platform policy and an approval audit trail before exposing high-impact Tools.
- Add adapter-specific synthetic integration tests for browser, runtime, database,
  infrastructure and observability implementations in later phases.
- Give Gardener access to aggregated missing-binding, incompatibility and recurring
  failure signals, with humans retaining decision authority.

Phase 08 should implement the trusted runner and `paved tool` commands against these
contracts before enabling consequential Tool execution. This review does not claim that
the Tool system is production-ready.
