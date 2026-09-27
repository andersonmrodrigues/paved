# Paved: instructions for agents

Paved gives you a predictable path for changing this repository: **context** tells you
how the project works, **constraints** tell you what must hold, and **verification**
tells you how to prove your change is correct. Follow the path; improve it when it is wrong.

Load only what the current task needs. This file is the map, not the territory:

| Load | When |
|---|---|
| This file and `.paved/manifest.yaml` | Always |
| One workflow, `workflows.md`, then the skills its phases name | When you know the kind of task |
| Feature-map entries and the context documents they link | When you know which code the task touches |
| `.paved/verification/profile.yaml` and `verification/README.md` | When you plan and run verification |

Paths starting with `.paved/` are in the repository you are working on. Other paths
(`workflows/`, `skills/`, `verification/`, `templates/`) are relative to the Core
`core/` directory, whose location the repository's root `AGENTS.md` gives you.

## 1. Discover context

1. Read `.paved/manifest.yaml` to learn the project, its adapters and its Core version.
2. Pick the workflow that matches the task (`feature`, `bug`, `refactor`, `performance`,
   `incident`, `release`) from `workflows/`, or a project workflow from
   `.paved/workflows/`. It tells you which inputs, phases, skills, checks, gates and
   approvals apply; `workflows.md` tells you how to run it. A workflow disabled in
   `.paved/overrides/overrides.yaml` does not apply to this repository.
3. Find the affected feature in `.paved/project/feature-map/` and read only the context
   documents it links to. Use the `context-discovery` skill when the map does not help.
4. Read the source code you will touch, and code that already solves a similar problem.

The code is the source of truth for what the system does; Project Context explains it.
When they disagree, trust the code and report the discrepancy. Read every context
statement with its state:

- **Known** (`observed` or `declared`): read from a source or stated by a person. Use it.
- **Inferred:** derived by reasoning. Use it as a lead; confirm it in the code first.
- **Unknown** (listed in `unknowns`): nobody knows yet. Do not fill the gap yourself.
- **Conflicting** (listed in `conflicts`): sources disagree. Do not pick a side silently.
- **Stale:** a recorded source hash no longer matches the file. Treat it as a hint.

## 2. Use skills

A skill is a directory with `SKILL.md` (instructions) and `skill.yaml` (the context,
tools, rules, dependencies and checks it declares). Load skills one at a time:

1. You see each active skill's `name` and `description`. Activate a skill when the
   workflow phase names it, when a human asks for it, or when its description matches
   the task. Do not load skills "just in case".
2. Read its `SKILL.md`. Load the context areas `skill.yaml` lists as `required`; load
   `optional` ones only when a step needs them.
3. Open files under the skill's `references/` or `examples/` only when a step points to
   them. When a step hands work to another skill, activate that skill at that step.

Project skills live in `.paved/skills/`. If `.paved/overrides/overrides.yaml` extends a
skill with an addendum, read it after the skill: it refines the skill, it does not replace
it. A skill the overrides disable does not apply. A `deprecated` skill says what to use
instead; use that.

### When a skill cannot proceed

Every skill lists its own failure modes. These apply to all of them:

| Situation | Do |
|---|---|
| Required context is missing | Look for it in the code and documentation (section 5). If it is still missing, continue only if the gap does not change the plan, and record it as unknown; otherwise ask |
| A required tool is unavailable | Say so and use the skill's stated fallback. Never improvise a destructive substitute |
| Requirements are ambiguous | Ask before changing code. State the interpretations you see |
| Project knowledge conflicts | Trust the code for what the system does; ask a human for what it should do. Do not pick a side silently |
| Verification fails | Fix the cause and re-run. Never weaken, skip or delete a check to make it pass |
| A rule blocks the change | Stop and say so. Only an override written by a human changes a rule |
| Evidence is insufficient | The task is incomplete. Say which claim lacks support and why |

## 3. Respect rules

Rules come from three places, in this order of specificity: Core (`core.*`), adapters
(`adapter-*.*`) and the project (`project.*`, in `.paved/rules/`). A rule applies when
its `applies_to` matches your change. Only `.paved/overrides/overrides.yaml` may change a
rule's severity or disable it, always with an owner and a reason, and never for a rule marked
`overridable: false`; you may not. If an override is flagged for review because its
target changed, apply the rule unmodified. If a rule blocks a correct change, stop and
say so.

## 4. Verify and produce evidence

"It compiles" is not "it is correct". Before declaring a task complete:

1. Build a plan from the workflow, active skills, applicable rules and acceptance
   criteria. Resolve each required check type to a check id in
   `.paved/verification/profile.yaml` and run its declared tool. Never assume a check
   exists that the profile does not declare.
2. Record an evidence file (`evidence.yaml`, see `templates/evidence.yaml`) that states each
   claim you make and the checks or artifacts that support it.
3. Record every expected check you could not run as a gap, with the reason. A required
   gap means the task remains incomplete; it does not turn into a pass.

Your evidence is a claim, not proof. Each check records who observed it
(`recorded_by`): results recorded by the Paved runner or CI weigh more than results you
report yourself, and the profile may require them. A task without evidence is not
complete. Say it is incomplete and explain why.

### Tool execution boundary

A Tool is a capability contract; a `ToolImplementation` supplies its mechanism. Finding
or reading a Tool does not authorize execution. Before invoking one, check its declared
permissions, safety class, environment and preconditions, then resolve exactly one
compatible implementation. Destructive and high-impact Tools require a separate human
approval for each invocation. Never invent a command when a binding is unavailable,
never execute an unresolved or ambiguous binding, and never interpolate inputs through
a shell. Preserve sanitized execution results as evidence; an agent's description of
what it believes happened is not a substitute for an observed result.

## 5. Handle the unknown

- Do not invent project knowledge: entities, rules, APIs, owners, conventions.
- When a skill needs information you do not have, look for it in this order: the code
  and tests; the repository's history, build and configuration files; Project Context in
  `.paved/project/`; the repository's documentation. Then ask a human.
- If it is still not found, it is unknown. Say so, and record it as an `unknown` in the
  relevant context document or as a gap in the evidence.
- Prefer an existing pattern in the repository over a new one. Introduce a new pattern
  only when no existing one fits, and say why in the evidence.

## 6. Improve the paved path

When you or a human correct the same kind of mistake twice, the path is missing
something. Use the `gardener` skill to propose a fix at the strongest layer possible
(architecture, static analysis, CI, rule, skill, documentation, in that order).
Propose; do not apply structural changes to Core or project rules on your own.

## Further reading (load on demand)

- `principles.md`: the principles behind these instructions.
- `lifecycle.md`: the task lifecycle phases and repository states.
- `workflows.md`: running a workflow: inputs, gates, approvals, failures, retries, run state.
- `verification/README.md`: check types, evidence and completion criteria.
