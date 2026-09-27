# 0007. Skill format

- **Status:** Accepted; contract extended by [0014](0014-skill-contract.md)
- **Date:** 2026-09-27

## Context

Skills must be usable by agents that know nothing about Paved, and checkable by Paved
tooling.

## Decision

- A skill is `SKILL.md` following the Agent Skills specification (frontmatter restricted
  to the fields it defines) plus a sidecar `skill.yaml` with the Paved contract (context,
  tools, rules, check types, evidence).
- Prose stays in `SKILL.md`; references tooling checks stay in `skill.yaml`.

## Consequences

- Any Agent Skills-compatible agent can load Paved skills.
- Two files per skill; a test keeps names and categories in sync.

## Alternatives considered

- **Paved fields in the SKILL.md frontmatter.** Rejected: the spec does not allow them.
- **A single YAML file with embedded prose.** Rejected: incompatible with other agents.

## References

- [Agent Skills specification](https://agentskills.io/specification)
