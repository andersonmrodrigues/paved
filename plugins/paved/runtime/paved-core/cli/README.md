# CLI

`paved` is the command-line frontend to the Paved runtime. It runs from a Core
checkout or the packaged artifact. The same handlers serve Codex and Claude Code
through their project-local launchers.

`paved evidence` and `paved tool ...` remain **contract-only** command families:
their contracts describe future behavior, but they are not executable commands in
this CLI yet.

## Commands

| Command | Purpose | Writes |
|---|---|---|
| [`paved init`](commands/init/README.md) | Create a new local `.paved/` state for a repository that is not initialized yet | `.paved/manifest.yaml`, `.paved/paved.lock`, `.paved/.gitignore`; generator outputs unless `--no-generate` |
| [`paved update`](commands/update/README.md) | Plan, stage, validate and commit local Core, adapter or source-input changes | `.paved/paved.lock` when resolution changes; affected context and disposable proposals |
| [`paved generate`](commands/generate/README.md) | Run all generators or selected generator ids and their dependencies | `.paved/project/`, `.paved/generated/`, `.paved/generated/state/last-run.json` |
| [`paved verify`](commands/verify/README.md) | Run the explicit verification profile through approved Tool bindings and record sanitized evidence | `.paved/generated/evidence/` |
| [`paved status`](commands/status/README.md) | Report initialized state, lock health, adapters, generator state, proposals, verification profile state, open runs, diagnostics and repair decisions | nothing, unless a repair decision is answered |
| [`paved doctor`](commands/doctor/README.md) | The diagnostics and repair decisions of `status`, kept as a CLI subcommand for the launcher and CI | nothing, unless a repair decision is answered |
| `paved gardener` | Analyze existing consumer evidence and report review proposals | nothing |
| `paved agent` | List, discover/resolve shared agent command contracts, validate, install, update or uninstall project-local agent projections | `.agents/`, `.claude/` or `.claude-plugin/` projection files |
| `paved intent` | Classify a request into the `feature`, `bug` or `refactor` workflow, write the Intent, and run `context` and `discovery` | `.paved/generated/runs/`, `.paved/documents/intents/`, evidence |
| `paved plan` | Run `planning` on the open run and record the approval the user gives in the conversation | `.paved/generated/runs/`, `.paved/approvals/` |
| `paved execute` | Run `implementation` through `completion`; validation invokes `test`, verification invokes `verify`, and new gardener proposals are listed | `.paved/generated/runs/`, evidence, `.paved/generated/gardener/reported.json` |
| `paved test` | Run the adopted module tests or the one declared testing Tool | `.paved/generated/evidence/` |
| `paved evidence ...` | **Contract-only.** Future evidence validation, show and list commands | not executable yet |
| `paved tool ...` | **Contract-only.** Future Tool discovery, inspection, validation and diagnosis commands | not executable yet |

## Common invocation

From a Core checkout, `--project` names the consumer repository. From a
project-local packaged runtime, run commands in the consumer repository.

```sh
node ./cli/index.ts --help
node ./cli/index.ts --version
node ./cli/index.ts status --project /absolute/path/to/repo --json
```

Global options accepted by implemented commands:

- `--project <dir>` selects the consumer root. Without it, the CLI uses the
  nearest ancestor containing `.paved/manifest.yaml`; if none exists, it uses the
  current directory as an uninitialized consumer.
- `--json` renders the same structured result used by human output.
- `--help`/`-h` prints global or command-specific help.
- `--version` prints the Core package version.

Command-specific options are intentionally narrow:

| Command | Options and inputs |
|---|---|
| `init` | `--dry-run`, `--no-generate`; no selectors; `--adapter` is rejected |
| `update` | `--dry-run`; no selectors; `--adapter` and remote update selectors are rejected |
| `generate` | `--dry-run`, optional `[generator-id...]` selectors; `--adapter` and `--force` are rejected |
| `verify` | `--adapter <id>` repeatable for content-root selection; no selectors, `--profile`, `--check`, shell command, or `--dry-run` |
| `status` | `--adapter <id>` repeatable; read-only unless `--answer` answers a repair decision |
| `doctor` | `--adapter <id>` repeatable; read-only unless `--answer` answers a repair decision; no `--run-checks` |
| `gardener` | `--dry-run`; read-only; no selectors or adapter selection |
| `agent` | `list`, `commands [codex\|claude-code]`, `command <name>`, or `<install\|update\|uninstall\|status\|validate> [codex\|claude-code]` |
| `intent` | The request, with `--workflow <feature\|bug\|refactor> --because <evidence>`, or `--recommend <id> --because <evidence>`, or one `--part <request>` per part; `--input <id>=<value>` repeatable |
| `intent`, `plan`, `execute` | `--run <id>` (required only when several runs are open), `--advance` with `--note` and `--evidence` as required, `--answer` |
| `plan` | `--approve` records the user's approval of the current plan, given in the conversation |

## Output and exit codes

All commands return one structured result: `command`, `status`, optional `data`,
and retained diagnostics. Human output and `--json` output are rendered from that
same result. Stack traces and raw process error objects are not printed.

The primary exit category is selected deterministically from diagnostics; internal
errors take precedence over all other categories, and warnings are retained even
when a blocking diagnostic decides the exit code.

| Code | Primary category | Meaning |
|---:|---|---|
| `0` | `success` | The command completed without findings. |
| `1` | `findings` | The command completed with warnings or non-blocking findings. |
| `2` | `usage` | Invalid invocation: unknown command, unsupported flag, missing flag value or unexpected argument. |
| `3` | `environment` | Local environment failure, such as an inaccessible project path or missing executable. |
| `4` | `config` | Invalid or missing Paved configuration/document state. |
| `5` | `resolution` | Core, adapter, reference, Tool or capability resolution failed. |
| `6` | `generation/update` | Generation or update planning/application failed. |
| `7` | `verification` | Required verification did not run, failed, or produced insufficient evidence. |
| `8` | `conflict` | A human edit or ownership conflict blocked direct application. |
| `9` | `internal` | Unexpected CLI/runtime failure. |

## Safety constraints

- Writing commands write only inside the consumer `.paved/` layout and never edit
  application source files.
- `--dry-run` for `init`, `update` and `generate` performs planning without final
  writes to the consumer; `init --dry-run` uses a cleaned-up OS temp scratch
  workspace instead of writing under the consumer or Core checkout.
- `init` refuses to reset existing `.paved/` state and validates existing manifest
  and lock documents before returning.
- `update` is local-only: it never downloads a Core, adapter or migration.
- `update` stages generation in a temporary consumer copy, checks for concurrent
  changes, validates the stage and swaps `.paved/` with a recoverable backup. Unknown
  compatibility and required migrations are reported without changing the lock.
- `status` and `doctor` expose a derived `lifecycleState` alongside lock health and
  diagnostics; `.paved/` presence alone never implies readiness.
- `generate` preserves human-edited generated content by writing proposals instead
  of overwriting.
- `verify` is explicit-only: it runs only checks listed by
  `.paved/verification/profile.yaml`, resolves declared Tool/ToolImplementation
  documents, invokes approved executables with `shell: false`, sanitizes output,
  and never infers commands from package scripts or arbitrary CLI arguments.
  Verification executables receive only `PATH`, temporary-directory variables
  and platform-required process variables; arbitrary caller environment values
  such as credentials are not inherited.
- `status` and `doctor` are read-only unless the user answers a repair decision.
- Agent command discovery and contract resolution are read-only. Executable
  commands use this same dispatcher. `paved test` requires an approved
  ToolImplementation and records sanitized evidence; it never infers scripts.
- Agent projection writes remain ownership-aware and refuse to overwrite
  user-owned command or skill files. Integrations include a project-local
  integrity-checking bootstrap launcher.

## Layout

```text
cli/
├── index.ts            # executable entry point
├── runtime.ts          # parser, help and dispatch
├── result.ts           # result shape and exit-code mapping
├── output.ts           # human and JSON renderers
├── commands/           # command implementations and per-command README files
└── lib/                # shared resolution, generator, verification and state libraries
```

The implementation language is TypeScript on Node.js 22.18+. The package builds
and runs independently from a tarball; public npm publication is pending.
