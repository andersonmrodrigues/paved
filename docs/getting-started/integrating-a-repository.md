# Integrating a repository

The packaged CLI implements `init`, `update`, `generate`, `test`, `verify`, `status`,
`doctor`, and durable development workflows. The steps below explain what still
needs human review after the native agent init command. An agent
can perform the project-owned steps with the
[repository-onboarding skill](../../core/skills/bootstrap/repository-onboarding/SKILL.md)
when a human asks it to.

## 1. Install the agent integration

The Codex or Claude Code integration includes a small launcher. Once installed
in the existing repository, `$paved-init` or `/paved:init` acquires the pinned
runtime, verifies its package integrity, and initializes `.paved/` without a
global install or application dependency. Package and integration distribution
have not yet been published; this consumer path is currently validated from a
packed local artifact in `tests/package/bootstrap.test.ts`.

For maintainers validating a checkout before publication:

```sh
git clone https://github.com/andersonmrodrigues/paved.git
cd paved
npm ci
node ./cli/index.ts agent install codex --project /absolute/path/to/repository --json
node ./cli/index.ts init --project /absolute/path/to/repository --json
```

The generated agent command uses its own project-local launcher. A direct
checkout CLI run records local Core digests; a launcher run also pins the
package integrity and installed content digest in `.paved/paved.lock`.

## 2. Initialize with Paved

Run `$paved-init` in Codex or `/paved:init` in Claude Code. Paved detects the stack,
resolves what repository evidence supports, and asks about material choices such as which
detected checks should become verification gates. Review the evidence and consequences,
then choose an offered option. Paved writes the approved profile itself.

```text
/paved:init
  → Paved detects the stack and resolves what the evidence proves
  → Paved asks which detected checks should become verification gates
  → you answer the emitted decision
  → Paved writes .paved/verification/profile.yaml
/paved:status   → GENERATED → VALIDATED → READY
```

When a command returns `awaiting_input`, use the exact decision id and option from its
result and resume the same command with `--answer <id>=<value> --answered-by <identity>`.
The identity must come from you. If Paved reports a blocking diagnostic without a
decision, follow its remediation; do not turn the diagnostic into a choice. Read the
[decision guide](../concepts/decisions.md) for batching and human-authored approvals.

## 3. Direct configuration (advanced)

Manual setup remains supported for teams that manage these contracts directly. For the
manifest, use [`core/templates/manifest.yaml`](../../core/templates/manifest.yaml).
Multi-stack repositories need no provider configuration when each stack lives in its own
directories: Paved resolves capability providers per scope from repository evidence and
records the decisions in `paved.lock` (see [scoped resolution](../concepts/adapters.md)).
If you manage provider selection manually, set `capability_providers` in the manifest for
the capability named in the diagnostic, either one adapter id for the whole repository or
a list of `{ path, provider }` for each scope. Choose based on the evidence the project
wants to use; Paved does not guess.

To hand-configure verification, copy
[`core/templates/verification-profile.yaml`](../../core/templates/verification-profile.yaml)
to `.paved/verification/profile.yaml`. For each existing build, test or analysis command,
create a Tool contract and a Check definition, then list the Check id in the profile.
Prefer checks CI already runs. Run each tool once to confirm it works. List check types
the project does not have under `unavailable`. Choosing a check configures a gate; only a
later `verify` run can produce passing evidence.

## 4. Add the agent entrypoint

The projected native commands live under `.agents/skills/` for Codex or
`.claude/commands/paved/` for Claude Code. Keep existing human-owned agent
instructions; the integration writer refuses to overwrite them.

## 5. Add context gradually

`paved generate` drafts Project Context. Review it, then add one
[`feature.yaml`](../../core/templates/feature.yaml) per feature an agent is likely to
work on, with `confidence: declared`. Add architecture notes under
`.paved/project/architecture/` as they become necessary. Record gaps as `unknowns`.

## 6. Add project rules and overrides only when needed

Add rules to `.paved/rules/` for constraints agents actually get wrong. Add
`.paved/overrides/overrides.yaml` only to adjust a specific Core rule, skill or workflow,
always with a reason (operations: [inheritance](../concepts/inheritance.md)). A project
workflow goes in `.paved/workflows/<name>/` under a name no Core workflow uses.

## 7. Validate

Run `paved doctor --json` through the packaged CLI or its agent launcher
to inspect the manifest, lock, selected adapters, generated provenance, overrides and
verification profile. It is read-only. Project review remains necessary before treating
generated context as declared knowledge.
