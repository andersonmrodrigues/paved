# Failure handling

Every part of Paved can fail: a document is invalid, a version is incompatible, a
generator cannot read a source, or a check cannot run. The rule for all of them is
principle 11: **fail explicitly, toward the stricter behavior.** A failure must be
visible, and it must never leave the agent with fewer constraints than it would
have had without the failure.

## Failure boundaries

Each boundary contains its failures so that one broken part does not silently
disable the rest.

| Boundary | Failure | Behavior |
|---|---|---|
| **CLI invocation** | Unknown command, unsupported flag, missing value, unexpected selector | The command returns `usage` exit `2`; no command handler runs for rejected arguments |
| **Core resolution** | No Core version satisfies the range; digest mismatch; unsupported `apiVersion` | Repository state is incompatible. Commands report the mismatch instead of partially trusting Core contracts |
| **Adapter resolution** | Adapter missing, incompatible `requires.core`, selected but undetected adapter, ambiguous capability | The adapter/capability is not loaded and the failure is reported. Core and other project content still apply |
| **Document validation** | A `.paved/` document fails its schema | The document is ignored for behavior that depends on it and reported by path. A broken project rule is never treated as "no rule" |
| **Composition/reference resolution** | Name collision, missing reference, invalid override target, duplicate override | The effective set is not computed until fixed; overrides are never silently dropped |
| **Override drift** | `target_sha256` mismatch | Subtractive overrides are suspended; the target applies at full strength ([inheritance](inheritance.md)) |
| **Initialization** | Existing `.paved/` state, invalid existing manifest/lock | `paved init` validates what exists and refuses to reset or update it |
| **Update** | Missing/invalid lock, incompatible local Core/adapter, changed generator with edited output | `paved update` is local-only, plans first, writes the lock only after preflight succeeds, and routes edited generated output to proposals/conflicts |
| **Generation** | Unknown selector, source unreadable, generator error, human-edited generated content | Invalid selectors are usage errors; runtime failures are reported; human-edited generated files are left in place and new output goes to proposals |
| **Verification** | Missing profile, unresolved check/tool, unauthorized tool, timeout, nonzero status, insufficient evidence | `paved verify` records failed/blocking outcomes when possible and exits `7`; a check that did not pass is never treated as successful |
| **Evidence** | Invalid record, unresolved reference, revision mismatch | Evidence assessment rejects the record. `paved evidence ...` is contract-only in the current CLI |
| **Tool execution** | Undeclared executable, unsafe binding, sensitive argv input, destructive safety without preconditions | The current verification runner executes only approved ToolImplementation bindings with `shell: false`; contract-only Tool subcommands are not executable yet |

## Principles behind the table

- **No partial success reported as success.** Every command reports what it did and
  what it did not do. `--json` output lists diagnostics and structured data.
- **Isolate by unit.** An invalid feature document invalidates that document, not
  the whole feature map. An incompatible adapter disables that adapter, not the Core.
- **Human knowledge is never the recovery path.** No failure mode overwrites a
  human-owned or project-owned file to restore consistency.
- **Unknown is a valid outcome.** A generator that produces mostly `unknowns` has
  worked correctly on a repository it cannot understand.
- **Verification is explicit.** The CLI never infers verification commands from
  package scripts or arbitrary command-line arguments.

## Exit codes

The implemented CLI uses stable exit codes shared by all production commands.
The primary category is selected deterministically from diagnostics; warnings are
retained even when a stricter blocking category decides the exit code, and
internal errors have highest precedence.

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

Generated proposals that do not involve an ownership conflict are non-blocking
findings (`1`) so humans can review them without treating the command as failed.
