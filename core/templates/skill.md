---
name: example-skill
description: >-
  What the skill does and when to use it, in one or two sentences with the keywords an
  agent would match on. Use when <the situations that should activate it>. Max 1024
  characters.
---

# Example skill

<!-- Instantiated as SKILL.md. Frontmatter follows the Agent Skills specification
     (https://agentskills.io/specification): only name, description, license,
     compatibility, metadata and allowed-tools. Paved metadata lives in skill.yaml.
     Every section below is required. Keep the body under 150 lines: move detail to
     references/, examples to examples/, and link each file from the step that needs it.
     Name no technology and no project fact; say where to find it instead. -->

## When to use

Situations that should activate this skill, and situations that look similar but should not.

## Required context

What to look for in each context area skill.yaml lists, and what to do if it is absent.

## Preconditions

What must be true before starting. If a precondition fails, say what to do instead.

## Procedure

1. Numbered, concrete steps.
2. Each step says what to look at and what decision to make.
3. A step that hands work to another skill names it (for example `unit-testing`).

## Tools

When to use each tool listed in skill.yaml (for example `core.repository.diff` to review the
change), and what to do when an optional tool is absent.

## Rules

Rules this skill is most likely to touch and how to stay compliant. Reference rules by id;
do not restate them.

## Verification

Which claims this skill usually produces and which check types prove them.

## Evidence

What the evidence record must contain for work done with this skill.

## Completion criteria

- Observable conditions that mean the skill's goal is reached.

## Failure modes

Failures specific to this skill. Generic ones (missing context, unavailable tools, failed
checks) are handled as the Paved instructions describe.

| Failure | Signal | Response |
|---|---|---|
| Common way this goes wrong | How to notice it | What to do |

## References

- Files under this skill's `references/`, `examples/` or `scripts/`, if any.
