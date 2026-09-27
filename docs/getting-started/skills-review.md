# Skills review

This records the skills pass at that point in the roadmap. For the current
implementation state and next milestone, see the [README](../../README.md).

What the skills pass defined, which decisions it made, and what it left open. The
skills are **well formed, small, generic and internally consistent**, and tests hold
them to that. Nothing here shows they are *good*: no skill has been used by an agent on
a real repository, and no measurement exists of whether following them produces better
changes. Paved is still not production ready: there are no CLI commands, runner or generator, and
the effective set of a consumer is not yet assembled by any code.

## Starting point

Nine skills existed, one per category, in a contract with a flat `tools` list,
`verification.check_types`, no version or status and no way to depend on another skill.
Two names did not match the catalog the specification asked for (`implement-change`,
`performance-investigation`). Nothing stopped a skill from growing, naming a technology
or restating a rule. This pass extended the existing format instead of adding a second
one ([ADR 0014](../decisions/0014-skill-contract.md) amends [ADR 0007](../decisions/0007-skill-format.md)).

## Research

| Source | Influence |
|---|---|
| [Agent Skills specification](https://agentskills.io/specification) | Frontmatter fields and limits; `scripts/`, `references/`, `assets/`; three-level progressive disclosure; SKILL.md under 500 lines, references one level deep |
| [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) | Per-skill versions; `0.x` for experimental |
| STRIDE threat categories | `threat-modeling` checklist |
| Existing Paved contracts | Qualified ids, visibility, evidence registry, overrides (no replace) |

## What exists now

- **Contract** (`schemas/skill.schema.yaml`): `version`, `status`, `deprecation`;
  required and optional tools and dependencies; required and recommended verification;
  supporting files in four directories. Details: [skills](../concepts/skills.md).
- **Catalog**: 19 Core skills in 9 categories, all `experimental`
  (`core/skills/README.md`); 10 new, 2 renamed, the rest revised.
- **Supporting material**: 3 references and 3 synthetic examples, each linked from the
  step that needs it; no scripts.
- **Context resolution**: `context_areas` in the Core manifest.
- **Generic behavior** in `core/instructions/AGENTS.md`: activation, loading order, a
  table of responses when a skill cannot proceed, and the search order for unknowns.
- **Tool** `core.repository.history`.
- **Library** `cli/lib/skills.ts`: quality checks, dependency cycles, duplicated
  sentences, unproving required checks, evidence against producer skills.
- **Docs**: [skills](../concepts/skills.md), [skill discovery](../concepts/skill-discovery.md),
  [progressive disclosure](../concepts/progressive-disclosure.md),
  [skill composition](../concepts/skill-composition.md).

## Key decisions

| Topic | Decision |
|---|---|
| Format | One format: Agent Skills `SKILL.md` + `skill.yaml`. No Paved fields in frontmatter |
| Discovery | Description ("Use when …") and workflows. No tags or aliases |
| Size | Body at most 150 lines and 1500 words; supporting files at most 300 lines |
| Context | Skills name areas; the manifest maps areas to paths; no project facts in skills |
| Tools and rules | Referenced by id; optional tools may be absent; rules never optional, never copied |
| Verification | `required` must pass or be a gap; `recommended` when available; required types must be able to prove something |
| Failures and unknowns | Generic handling once in the instructions; skills list their own failures |
| Composition | `depends_on` required/optional; acyclic; loaded at the step that names it |
| Overrides | `extend` preferred; disable and add a project skill as the conservative replacement; no `replace` |
| Lifecycle | Draft (proposal) → experimental (`0.x`) → stable (`>= 1.0.0`) → deprecated (with migration) → removed |

## Audit

| # | Question | Result |
|---|---|---|
| 1 | One skill format, compatible with Agent Skills? | Yes; frontmatter checked against the specification's fields |
| 2 | Every skill under the size limits? | Yes; largest body 92 lines, 621 words |
| 3 | Technology-neutral? | Denylist and identifier scans pass. Heuristic: a technology not on the list would pass |
| 4 | Free of project knowledge? | Scans pass; examples are synthetic and labeled so. Semantic check needs review |
| 5 | Rules referenced, not copied? | Yes; copied statements fail a test |
| 6 | Tools referenced through contracts? | Yes; skills reference Tool capabilities by id and do not embed commands |
| 7 | Every change skill verifiable? | Yes; each requires a check type able to prove something and an evidence kind |
| 8 | Completion criteria machine-checkable? | Partly: required checks and evidence kinds are (`assessSkillEvidence`); the rest are observable conditions for review |
| 9 | Dependencies acyclic and resolvable? | Yes; tested |
| 10 | Duplicated knowledge? | No sentence of 12+ words repeats across skills (tested). Shorter overlaps and paraphrases are not detected |
| 11 | Hidden assumptions at this pass? | Git was assumed by Core tools (corrected by ADR 0019). Skills assume a verification profile exists and say what to do without it |
| 12 | Versioning and deprecation enforceable? | Schema ties status and version and requires migration info |
| 13 | Docs match the implementation? | Concept pages, contracts, versioning, enforcement candidates and changelog updated; links tested |

## Tests

`npm run check` passes: strict type check and 271 tests. New coverage: the quality
checks on every Core skill and on 9 skill fixtures (8 invalid, each failing for stated
reasons); skill schema fixtures for missing version, deprecated without migration,
deprecation on an active skill, experimental at 1.x, stable at 0.x and nested
reference paths; reference fixtures for unknown dependencies, unknown required tools and
absent optional tools; evidence assessed against producer skills (2 sound, 3 unsound);
the `context_areas` map against the context-area enum and the consumer layout. No
linter is configured.

## Known limits

- **Quality checks are heuristics.** The technology denylist and CamelCase identifier
  pattern catch common leaks, not all; lower-case project names pass. The duplicate
  check misses paraphrase.
- **No effective set.** Optional references, disabled dependencies resolving to a
  same-named project skill, short-name uniqueness across layers and addenda are
  specified but need the CLI's effective-set assembly.
- **Evidence check scope.** `assessSkillEvidence` checks kinds and check types, not
  whether the check exercised the skill's claims.
- **`regression-testing` requires `unit`** even when the right level is higher; the
  skill says to record a gap naming the level used. A per-invocation level would need a
  richer contract.
- **Frontend and backend performance** give generic guidance only; measurement tooling
  must come from adapters, none of which exist yet.
- **No usage data.** Whether agents activate the right skill from its description, and
  whether the procedures improve outcomes, is untested.

## Future work

1. Run the skills with an agent on sample repositories and record where they mislead.
2. Effective-set assembly in the CLI, then run the skill checks on project and adapter
   skills in `paved validate`.
3. Adapters that supply technology knowledge and tools for testing and performance.
4. Promote skills to `stable` once they have been used and reviewed.
5. A runner that logs what agents load, to measure progressive disclosure.
