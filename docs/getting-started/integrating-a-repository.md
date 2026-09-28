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

## 2. Create the manifest

`paved init` creates `.paved/manifest.yaml` from detected local adapters. Review its
human-owned project name, Core range and adapter selections. For manual setup, use
[`core/templates/manifest.yaml`](../../core/templates/manifest.yaml).
If initialization reports `PAVED_ADAPTER_AMBIGUOUS_PROVIDER`, explicitly set
`capability_providers` in the manifest using the capability and candidate adapter ids
from the diagnostic. Choose based on the evidence the project wants to use; Paved does
not guess. `status` and `doctor` continue to report unresolved provider ambiguity until
the manifest is corrected.

## 3. Declare verification

Copy [`core/templates/verification-profile.yaml`](../../core/templates/verification-profile.yaml)
to `.paved/verification/profile.yaml`. For each existing build, test or analysis
command, create a Tool contract and a Check definition, then list the Check id in the
profile. Prefer checks CI already runs. Run each tool once to confirm it works. List
check types the project does not have under `unavailable`.

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
