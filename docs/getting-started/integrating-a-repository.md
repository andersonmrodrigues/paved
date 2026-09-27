# Integrating a repository

The local CLI implements `init`, `update`, `generate`, `verify`, `status` and `doctor`.
The steps below explain what still needs human review after `paved init`. An agent
can perform the project-owned steps with the
[repository-onboarding skill](../../core/skills/bootstrap/repository-onboarding/SKILL.md)
when a human asks it to.

## 1. Make the Core available

Make a local Core checkout available to the CLI. `paved init --project <repo>` resolves
that checkout and writes exact versions and digests to `.paved/paved.lock`. The local
CLI does not materialize `.paved/generated/core/`; Core distribution is planned.

## 2. Create the manifest

`paved init` creates `.paved/manifest.yaml` from detected local adapters. Review its
human-owned project name, Core range and adapter selections. For manual setup, use
[`core/templates/manifest.yaml`](../../core/templates/manifest.yaml).

## 3. Declare verification

Copy [`core/templates/verification-profile.yaml`](../../core/templates/verification-profile.yaml)
to `.paved/verification/profile.yaml`. For each existing build, test or analysis
command, create a Tool contract and a Check definition, then list the Check id in the
profile. Prefer checks CI already runs. Run each tool once to confirm it works. List
check types the project does not have under `unavailable`.

## 4. Add the agent entrypoint

Copy the block from [`core/templates/AGENTS.md`](../../core/templates/AGENTS.md) into the
consumer's root `AGENTS.md`, adjusting the Core path if it differs. Keep existing
content outside the block.

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

Run `paved doctor --project <repo>` to inspect the manifest, lock, selected adapters,
generated provenance, overrides and verification profile. It is read-only. Project
review remains necessary before treating generated context as declared knowledge.
