# Failure handling

Every part of Paved can fail: a document is invalid, a version is incompatible, a
generator cannot read a source, a check cannot run. The rule for all of them is
principle 11: **fail explicitly, toward the stricter behavior.** A failure must be
visible, and it must never leave the agent with fewer constraints than it would have had
without the failure.

## Failure boundaries

Each boundary contains its failures, so that one broken part does not disable the rest.

| Boundary | Failure | Behavior |
|---|---|---|
| **Core resolution** | No Core version satisfies the range; digest mismatch; unsupported `apiVersion` | Repository state *incompatible*. Agents are told not to rely on Core contracts; nothing is partially loaded |
| **Adapter resolution** | Adapter missing, incompatible `requires.core`, missing required adapter | That adapter is not loaded and the failure is reported. Core and project content still apply; checks that only the adapter would have suggested become gaps |
| **Document validation** | A `.paved/` document fails its schema | The document is ignored and reported by path. A broken project rule is never treated as "no rule": `paved doctor` fails, and CI should too |
| **Composition** | Name collision; override on a missing or non-overridable target; duplicate override | Error. The effective set is not computed until it is fixed. Overrides are never silently dropped |
| **Override drift** | `target_sha256` mismatch | Subtractive overrides are suspended; the target applies at full strength ([inheritance](inheritance.md)) |
| **Generation** | Source unreadable; ambiguous detection; model output unusable | The generator records `unknowns` and continues; it never fills the gap. A generator crash leaves existing files untouched: output is written only after it is complete and validated |
| **Regeneration conflict** | A human edited generated content | The new output goes to `.paved/generated/proposals/`; the human version stays ([ownership and regeneration](ownership-and-regeneration.md)) |
| **Verification** | A check cannot run; a profile check is missing; a check errors | Recorded as `status: error` or as a gap. An erroring check is not a passing check: a `complete` record may not contain one |
| **Evidence** | Invalid record; unresolved reference; revision mismatch | The task is not complete. The record, not the agent, is wrong until fixed |
| **Update/migration** | Migration fails validation | Nothing is applied: dry run first, then apply, then validate; on failure, restore the previous lock and files |
| **Tool** | A destructive tool without confirmation | Not executed (contract today; runtime enforcement later) |

## Principles behind the table

- **No partial success reported as success.** Every command reports what it did not do.
  `--json` output lists failures per item.
- **Isolate by unit.** An invalid feature document invalidates that document, not the
  whole feature map. An incompatible adapter disables that adapter, not the Core.
- **Human knowledge is never the recovery path.** No failure mode overwrites a
  human-owned or project-owned file to restore consistency.
- **Unknown is a valid outcome.** A generator that produces mostly `unknowns` has
  worked correctly on a repository it cannot understand.

## Exit codes (provisional)

The [CLI contract](../../cli/README.md) defines `0` success; `1` the command ran and
found problems (failed checks, invalid documents, incompatibility); `2` usage error; `3`
environment error. They are provisional until an implementation exercises them.
