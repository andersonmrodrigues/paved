# 0014. Skill contract, versioning and composition

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

[ADR 0007](0007-skill-format.md) fixed the format: Agent Skills `SKILL.md` plus a Paved
`skill.yaml`. The first skills showed what that contract lacked: no way to say which
tools or dependencies are optional, no version or lifecycle per skill, no notion of
skills using each other, verification that could not distinguish "must prove" from
"worth running", and nothing that stopped skills from growing, naming technologies or
copying rules.

## Decision

- `skill.yaml` gains `version` (SemVer) and `status` (`experimental`, `stable`,
  `deprecated`). `experimental` means below 1.0.0 and `stable` means 1.0.0 or above;
  a deprecated skill must carry `deprecation` (`since`, `migration`, optional
  `replaced_by`). Drafts are not skills; removed skills do not exist.
- `tools` and `depends_on` split into `required` and `optional`; optional references may
  be absent from the effective set. `rules` stays a flat list: rules are never optional.
- `verification` splits into `required` (each must be a passed check or a gap) and
  `recommended`. A check type that supports no claim cannot be required.
- `references` lists every supporting file under `references/`, `examples/`, `scripts/`
  or `assets/`, one level deep.
- The Core manifest maps each context area to its consumer path (`context_areas`), so
  skills name areas, never paths.
- Generic failure handling and the unknowns procedure live once in
  `core/instructions/AGENTS.md`; skills list only their own failures.
- No tags or aliases: the description and workflows are the discovery surface.
- Quality rules that JSON Schema cannot express are library checks
  (`cli/lib/skills.ts`): size limits, technology and identifier scans, no shell blocks,
  an activation phrase, contract fields named in the body, no copied rules, no
  duplicated sentences, acyclic dependencies, and evidence satisfying producer skills.
- Two Core skills are renamed to match the catalog (`implement-change` →
  `feature-development`, `performance-investigation` → `profiling`) while everything is
  `0.x`.

## Consequences

- Every Core skill changed shape; consumers with project skills must add `version` and
  `status` and move `tools` and `check_types` into the new structure (breaking, within
  `0.x`).
- A project can see which skill changed incompatibly without reading every diff.
- The quality checks are heuristics: the technology denylist and identifier pattern
  catch common leaks, not all of them, and they cannot judge whether advice is good.

## Alternatives considered

- **Skills versioned only by the Core release.** Rejected: a project could not tell
  which of twenty skills changed incompatibly.
- **Tags and aliases for discovery.** Rejected: a second matching surface next to the
  description, which drifts.
- **Failure handling repeated in every skill.** Rejected: duplicated text that diverges,
  and more lines in every activated skill.
- **A `replace` override for skills.** Rejected again (see [ADR 0003](0003-composition-and-overrides.md)).

## References

- [skills](../concepts/skills.md), [skill discovery](../concepts/skill-discovery.md),
  [progressive disclosure](../concepts/progressive-disclosure.md),
  [skill composition](../concepts/skill-composition.md)
- [Agent Skills specification](https://agentskills.io/specification)
