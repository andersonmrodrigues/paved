# Phase 10: Production CLI and end-to-end Paved workflow

## Goal

Add the first production-facing `paved` executable over the Phase 01–09 contracts and
shared libraries. The CLI coordinates existing services; it does not interpret
technologies, project architecture, or business domains and does not duplicate adapter,
generator, ownership, provenance, lock, or evidence semantics.

The first command set is `init`, `update`, `generate`, `verify`, `status`, and `doctor`.
The documented `evidence` and `tool` command contracts are not expanded into additional
production commands in this phase.

## Current constraints

- The repository uses strict TypeScript on Node.js 22.18+ and has no CLI executable or
  parser dependency.
- `cli/lib/adapters.ts` provides detection, adapter resolution, capability resolution,
  and evidence collection. `cli/lib/generator-runtime.ts` provides consumer
  initialization and generator execution, including ownership-aware output handling.
- Schema, Tool policy, provenance, and evidence assessment functions already exist.
  There is not yet a production command dispatcher or a safe verification process runner.
- Core and adapter resolution are local-only. Remote distribution, registry access, and
  auto-update are out of scope.
- Apecatus already has `.paved/manifest.yaml`, a lock, and generated context. The real
  consumer pass must therefore be non-destructive and must not edit application source.
- Existing worktree changes in the shared adapter and generator libraries are prior
  work and must be preserved while wiring the CLI.

## Architecture

Use one shared CLI runtime and thin command services:

```text
cli entrypoint
  -> argument parsing and consumer-root resolution
  -> command service
  -> existing Core library or a shared cli/lib service
  -> structured command result
  -> human or JSON renderer
  -> stable exit code
```

The shared runtime owns command parsing, `--project` resolution, output mode,
diagnostic/error types, and exit-code selection. Command services receive resolved
paths and dependencies, then call the existing adapter resolver, Generator Runtime,
schema registry, Tool policy, and evidence assessment. New lifecycle logic belongs in
shared `cli/lib` services when it is reused or enforces a Core contract; handlers remain
orchestration-only.

Use Node.js and the existing TypeScript setup without a new command framework
dependency. Provide a Node shebang entry point and a local package command for
development and tests. This does not introduce a package registry, download mechanism,
or distribution system.

## Commands and safety

| Command | Responsibilities | Mutation boundary |
|---|---|---|
| `paved init` | Discover/validate consumer state, detect and resolve adapters, create a manifest and lock only when absent, initialize required Paved paths, invoke generation unless disabled, then diagnose the result. Existing `.paved/` state is reported and preserved; no implicit reinitialization. | Only new Paved-owned paths and explicitly supported managed blocks; never application source. |
| `paved update` | Compare the project manifest and lock with the local Core/adapters, validate compatibility, identify changed generator inputs, and apply only safe lock/cache/regeneration changes. | `--dry-run` is read-only. Conflicts or untrusted baselines become proposals/diagnostics; human-owned files are not overwritten. |
| `paved generate` | Invoke the existing Generator Runtime, optionally with supported generator selectors and `--dry-run`; render writes, unchanged outputs, proposals, conflicts, and errors. | Only `generated-reviewed` and `disposable` paths through the existing ownership/baseline model. |
| `paved verify` | Load explicit project verification configuration; resolve checks, Tools, and implementations; authorize inputs and preconditions; execute approved commands as separate argv elements without a shell; sanitize bounded output; write evidence and assess completion. Missing policy/configuration is a gap/error, never permission to run discovered scripts. | Writes evidence only under its configured Paved evidence location. Never executes an arbitrary repository script. |
| `paved status` | Inspect project identity, Core and adapter lock state, generation state, proposals/conflicts, verification configuration, and obvious context staleness without regenerating. | Read-only. |
| `paved doctor` | Validate manifests/locks/documents, adapter and capability resolution, generated provenance/baselines, required paths, and verification configuration; return actionable structured diagnostics. | Read-only; no automatic repair. |

All commands accept `--project <path>` where applicable. Initialized nested invocations
resolve the nearest ancestor `.paved/manifest.yaml`; an uninitialized repository uses
the explicit path or current directory as its root and is not guessed from technology
files. Paths are normalized before any filesystem operation. Every write is checked
against the Core `consumer_layout`; generated outputs additionally go through the
Generator Runtime's ownership and baseline rules.

`init`, `update`, and `generate` support `--dry-run` and must not mutate state in that
mode. `status` and `doctor` never write. Command-specific selectors and options follow
the existing command contracts where the underlying service supports them; the CLI
does not introduce a second selection or generation model.

## Verification execution boundary

There is no general shell runner. The verification service resolves a declared Check to
a declared Tool and ToolImplementation, validates inputs, environment, permissions,
preconditions, timeout, and approval through the existing policy functions, and builds
an executable plus argv using `buildArgv`. Execution uses a shell-free child-process
API with bounded output and timeout. Output and error diagnostics pass through secret
sanitization before display or evidence persistence. Only explicitly configured checks
may run; filenames, CI configuration, README examples, and package scripts are not
approval.

The service records structured check results and evidence, then invokes the existing
schema and semantic evidence assessment. It does not create a competing verification
policy or mark missing checks as passing.

## Results, output, and exit codes

Each command returns a typed result containing command identity, status, structured
data, diagnostics, and any command-specific summary. Human and JSON output are rendered
from that same result. JSON output is never reconstructed from terminal text and must
not include raw secrets, stack traces, or unbounded process output.

Stable exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | Command completed with non-blocking findings or warnings |
| 2 | Invalid command or input |
| 3 | Environment/repository access failure |
| 4 | Invalid or incompatible Paved configuration |
| 5 | Adapter, capability, or other resolution failure |
| 6 | Generation or update execution failure |
| 7 | Verification failure or incomplete required verification |
| 8 | Ownership conflict requiring review |
| 9 | Unexpected internal error |

When multiple diagnostics occur, the result retains all of them and selects one primary
exit category deterministically, with unexpected internal errors taking precedence and
otherwise using the command's blocking failure category. The mapping is documented and
tested; callers do not parse human-readable output.

## Delivery sequence

1. Build the shared runtime, executable entry point, typed results/diagnostics, renderers,
   exit mapping, and isolated dispatcher tests.
2. Implement read-only `status` and `doctor` against existing schemas, locks, adapters,
   generator state, and provenance.
3. Wire `init` and `generate` to the adapter resolver and Generator Runtime; cover
   idempotency, ownership, selectors supported by the runtime, and dry-run behavior.
4. Implement `update` on top of local compatibility and lock semantics, preserving
   changed human content and proposing conflicts rather than overwriting.
5. Implement `verify` with explicit policy resolution, shell-free authorized execution,
   sanitized evidence, and completion assessment.
6. Add synthetic consumer fixtures for every command and safety boundary; then run
   `npm run check` and the Apecatus end-to-end flow without changing application source.
7. Update CLI and user documentation, including options, mutations, safety behavior,
   diagnostics, and exit codes.

## Validation and acceptance

- The package strict typecheck and full existing test suite pass through `npm run check`.
- CLI tests use temporary repositories only and do not require Apecatus, network,
  credentials, databases, or external services.
- Tests cover dispatch/help/version, valid and invalid consumers, adapter resolution,
  fresh and initialized `init`, generator idempotency/dry-run/conflicts, update safety,
  successful and failing verification, missing verification configuration, status,
  doctor, JSON parity, deterministic exit codes, no arbitrary command execution, and
  secret-safe diagnostics.
- The Apecatus pass reports the existing Git, Java, Quarkus, Angular, and PostgreSQL
  adapters; it does not add Node or CI adapters and does not modify application source.
- Apecatus `init` is exercised against its existing state without force or destructive
  reinitialization. Its missing verification configuration is reported honestly rather
  than filled with unapproved commands.
- No Phase 11 multi-repository lifecycle, Phase 12 Gardener, remote distribution, or
  technology-specific CLI logic is introduced.

## Known limits

The Core has no remote resolver, so `update` can only use available local Core and
adapter content. Verification can execute only checks with complete explicit Tool,
implementation, and policy bindings; unsupported checks remain visible as gaps.
Packaging beyond the local executable entry point is deferred.
