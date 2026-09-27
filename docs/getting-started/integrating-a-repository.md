# Integrating a repository

The CLI is not implemented yet. Until it is, a repository can adopt Paved by hand; the
steps below are what `paved init` will automate. An agent can perform them with the
[repository-onboarding skill](../../core/skills/bootstrap/repository-onboarding/SKILL.md)
when a human asks it to.

## 1. Make the Core available

Clone or check out this repository at a tagged version somewhere agents can read. For
the manual flow, place a read-only copy at `.paved/generated/core/` in the consumer
(and add `.paved/generated/` to the consumer's ignore file), or point the `AGENTS.md`
block at wherever the Core lives. Do not edit that copy.

## 2. Create the manifest

Copy [`core/templates/manifest.yaml`](../../core/templates/manifest.yaml) to
`.paved/manifest.yaml`. Set the project name and the Core range. Leave `adapters` empty
unless a matching adapter exists.

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

Without generators, start with the feature map: one
[`feature.yaml`](../../core/templates/feature.yaml) per feature an agent is likely to
work on, with `confidence: declared`. Add architecture notes under
`.paved/project/architecture/` as they become necessary. Record gaps as `unknowns`.

## 6. Add project rules and overrides only when needed

Add rules to `.paved/rules/` for constraints agents actually get wrong. Add
`.paved/overrides/overrides.yaml` only to adjust a specific Core rule, skill or workflow,
always with a reason (operations: [inheritance](../concepts/inheritance.md)). A project
workflow goes in `.paved/workflows/<name>/` under a name no Core workflow uses.

## 7. Validate

Validate each YAML document against its schema, for example with a short script using
this repository's `cli/lib/schemas.ts` (`createRegistry("<core>/schemas").validate(doc)`).
`paved doctor` will do this once implemented.
