# CLI

`paved` is the command-line interface for installing, updating, generating, verifying
and diagnosing Paved in a consumer repository. **The commands are specified, not
implemented.** `cli/lib/` contains tested implementations for document and schema
validation, reference resolution, provenance, skill and workflow assessment, Check and
Evidence assessment, and Tool discovery, policy and capture. There is no command runner,
consumer installation path or production execution boundary yet.

## Commands

| Command | Purpose | Writes |
|---|---|---|
| [`paved init`](commands/init/README.md) | Set up Paved in a repository | `.paved/` skeleton, manifest, lock, AGENTS.md block |
| [`paved update`](commands/update/README.md) | Move to a new Core or adapter version | lock, resolved Core cache, migrations (with confirmation) |
| [`paved generate`](commands/generate/README.md) | Run generators | `.paved/project/`, `.paved/generated/` |
| [`paved verify`](commands/verify/README.md) | Run profile checks and validate evidence | `.paved/generated/evidence/` |
| [`paved evidence`](commands/verify/README.md) | Validate, inspect and list evidence | nothing |
| [`paved status`](commands/status/README.md) | Report the repository's Paved state | nothing |
| [`paved doctor`](commands/doctor/README.md) | Diagnose problems and suggest fixes | nothing |
| [`paved tool list`](commands/tool/README.md) | Discover Tool capability contracts and availability | nothing |
| [`paved tool inspect <tool>`](commands/tool/README.md) | Show contract, policy and resolved implementation metadata | nothing |
| [`paved tool validate <tool>`](commands/tool/README.md) | Validate contract, binding and override compatibility | nothing |
| [`paved tool doctor`](commands/tool/README.md) | Diagnose missing, ambiguous or incompatible bindings | nothing |

## Conventions all commands follow

- **Consumer layout is law.** Before writing a path, a command resolves its ownership
  from the Core manifest's `consumer_layout` and refuses to write human-owned or
  project-owned paths except where its contract explicitly allows it (for example `init`
  creating a file that does not exist yet).
- **Dry run.** Every writing command supports `--dry-run`, printing the planned changes.
- **Machine-readable output.** Every command supports `--json` with a stable structure,
  so agents and CI can consume results.
- **Non-interactive by default in CI.** Prompts are skipped when stdin is not a TTY;
  operations that would need confirmation then fail with a clear message instead.
- **Exit codes.** `0` success; `1` the command ran and found problems (failed checks,
  invalid documents, incompatibility); `2` usage error; `3` environment error (missing
  tool, unreadable repository).

## Layout

```text
cli/
├── commands/<command>/   # command contract (README.md); implementation later
└── lib/                  # tested validation, resolution, policy and assessment libraries
```

The implementation language is TypeScript on Node.js (chosen for the bootstrap; see
`docs/getting-started/bootstrap-review.md`). How the CLI is distributed (npm package,
standalone binary) is still open.
