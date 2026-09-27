# Skill discovery and activation

How an agent finds the skill for a task, and what happens when it activates one.
Agent-facing version: `core/instructions/AGENTS.md`, "Use skills".

## Discovery

An agent discovers skills the way the Agent Skills specification intends: at startup
it knows every active skill's `name` and `description` (about a hundred tokens each)
and nothing else. The effective set is Core, then selected adapters, then the project,
minus disabled skills ([inheritance](inheritance.md)).

A task is matched against skills along five signals, strongest first:

| Signal | Source | Example |
|---|---|---|
| Workflow | The workflow for the change type names skills per phase | Bug workflow, `discovery` phase → `bug-investigation`, `root-cause-analysis` |
| Explicit request | A human names the skill or its purpose | "Write a threat model for this" |
| Intent | The description's "Use when …" sentence | "profile why this is slow" → `profiling` |
| Technology | Adapter skills are in the set only when the adapter is selected | An adapter's build skill appears only in repositories that use it |
| Project context | The feature map and context areas point at what the task touches | A change in an integration makes `integration-testing` relevant |

Paved adds no tags, aliases or keyword registries: the description is the matching
surface, and workflows cover the systematic cases. This keeps one place to edit when a
skill's scope changes, and keeps skills portable to agents that know nothing of Paved.

Short names are unique among active skills, so "use `profiling`" is never ambiguous.

## Activation

A skill is activated when one of these happens:

1. A workflow phase that names it begins.
2. A human asks for it.
3. Its description matches the task and no workflow phase already covers the work.
4. Another active skill reaches a step that hands work to it (a dependency).

On activation the agent:

1. Reads the whole `SKILL.md` body.
2. Reads `skill.yaml`: resolves each **required** context area through the Core
   manifest's `context_areas`, and reads it; notes the **optional** areas without
   reading them.
3. Checks the preconditions. A failed precondition means following the skill's stated
   alternative, not continuing.
4. Reads any addendum an `extend` override attaches to the skill.
5. Follows the procedure, loading optional context, supporting files and dependency
   skills only at the step that asks for them ([progressive disclosure](progressive-disclosure.md)).

A deprecated skill still activates, but the agent reports the deprecation and its
migration note, and prefers the replacement when one is named.

## When nothing matches

The agent proceeds with the general instructions, records that no skill applied, and
treats the case as a Gardener signal if it recurs: a missing skill is a gap in the
paved path, not a reason to improvise one silently.
