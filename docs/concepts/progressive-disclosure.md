# Progressive disclosure

An agent's context is small, and irrelevant text makes it worse at the task. Paved
loads each piece of guidance only when something the agent has just learned makes it
relevant. This page applies the principle to skills; the tiers for all Paved content are
in [context loading](context-loading.md).

## Levels

| Level | Loaded when | Contains | Size budget |
|---|---|---|---|
| 1. Metadata | Agent starts | Each active skill's `name` and `description` | About 100 tokens per skill |
| 2. Instructions | Skill activated | The `SKILL.md` body; `skill.yaml`; required context areas | Under 150 lines |
| 3. Optional context | A step needs it | Optional context areas named in `skill.yaml` | Only the documents the step names |
| 4. Supporting material | A step links to it | `references/`, `examples/`, `assets/` files | Under 300 lines each |
| 5. Dependencies | A step hands work over | The dependency skill, from its level 2 | One skill at a time |
| 6. Execution | A step says to run it | `scripts/`, tools, verification commands | Output only, not source |

Levels 1, 2 and 4 are the Agent Skills specification's three levels; Paved adds optional
context, dependencies and execution as separate steps because each has its own trigger.

## What goes where

| Content | Level | Why |
|---|---|---|
| When to activate | 1 (description) | The only text an agent sees before activation |
| Steps, decisions, completion criteria, skill-specific failures | 2 | Needed every time the skill runs |
| Generic failure handling, the unknowns procedure | Always loaded (`core/instructions/AGENTS.md`) | Needed by every skill; written once |
| Checklists, protocols, categories, tables longer than a screen | 4 (`references/`) | Needed at one step, not at all |
| Worked illustrations of the output | 4 (`examples/`) | Helpful when producing the output, noise otherwise |
| Commands | Tools and the verification profile | Project- and technology-specific |
| Technology specifics | Adapter knowledge (level 3, `technology` area) | Only relevant where the technology is used |
| Project facts | Project Context (level 3) | Differ per repository |

## Rules

1. **Point from the step.** A supporting file is linked from the step that needs it, and
   listed under References. A file nothing points to is never read, so it is dead.
2. **One level deep.** Supporting files do not link to further supporting files; the
   agent should never chase a chain of references.
3. **Small by default.** When `SKILL.md` grows past its limit, move detail down a level;
   do not raise the limit.
4. **Name, don't embed.** A skill names a context area, tool, rule or dependency and
   lets the agent load it; it never copies the content in.
5. **Dependencies load late.** A dependency is loaded at the step that names it, not when
   the depending skill is activated, and only if that step is reached.

The size limits and rules 1, 2 and 4 are enforced by tests ([skills](skills.md#validation));
rule 5 is guidance until a runner logs what agents load.
