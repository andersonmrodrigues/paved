# Paved: instructions for agents

Paved gives you project context, constraints and verification. Use its lean router and
playbooks as needed; default to direct, outcome-focused work rather than a phase-based
workflow.

Use `paved status` when you need to understand installation state, `paved context
"<topic or path>"` for relevant project rules and feature summaries, and
`paved verify --changed` to run checks for the current change. Use `paved task` only
when a task needs a durable handoff across multiple steps or sessions. Keep small
changes direct; for larger changes, keep the plan in that handoff instead of creating
extra planning documents.

Use `paved intent`, `paved plan` and `paved execute` only when the user explicitly
requests a governed workflow or a project rule requires one. When resuming such a
workflow, continue only the matching run. Investigation-only and planning-only requests
stay read-only and stop at their requested outcome. Do not require plan approval for
ordinary implementation. Ask a person for product decisions, conflicting rules,
irreversible actions, or persistent verification failures after two distinct fixes.
Respect explicit user direction and never treat autonomy or a plan as permission for a
high-impact operation.

The intent/plan/execute commands remain available for explicit workflow runs. They share
one run with phase-specific gates; `workflows.md` explains that optional path. Projected
commands are generated from `paved agent commands --json`; do not install an unpinned
runtime or substitute arbitrary shell commands when the Paved launcher is unavailable.

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

1. Read `.paved/manifest.yaml` and the relevant feature-map entry only when they help
   identify project rules, adapters or affected code.
2. Use `paved context "<topic or path>"` to retrieve relevant context under its stated
   budget. A truncated result is incomplete; narrow the query or raise the budget before
   relying on it.
3. Read the source code you will touch, and code that already solves a similar problem.
4. Load a workflow and `workflows.md` only when the user explicitly requests a governed
   workflow or a project rule requires one. Its phases, gates and approvals do not apply
   to ordinary direct work.

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
| Requirements are ambiguous | Triage the question first (section 5): find out what is observable, then ask before changing code about what remains a preference, stating the interpretations you see |
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

1. Run the relevant project checks. In an initialized repository,
   `paved verify --changed` selects and records checks from
   `.paved/verification/profile.yaml`; never assume a check exists that the profile does
   not declare. Otherwise, use the repository's documented test and build commands.
2. Keep command output and inspect relevant side effects. Paved verification writes its
   evidence automatically; a direct task does not need a separate workflow evidence file.
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
- Before you ask a human anything, classify the question:
  - **Observable:** the answer is a fact you can get by reading code or running
    something: current behavior, output, timing, layout, whether a test fails today.
    Find out instead of asking. Read the code, run the existing tests or the program, or
    try a throwaway experiment outside the repository; an experiment inside the
    repository follows the `prototyping` skill. Ask only when you cannot observe it
    (no access, no safe way to run it, a shared or production system), and say why.
  - **Preference:** a product, scope, priority or taste call that no experiment
    settles. Only these go to the human, with the interpretations you see.

  Triage never replaces a human step: plan approval, confirmation of destructive or
  high-impact actions, and every decision Paved emits stay with a person, however
  observable the facts behind them are.
- Prefer an existing pattern in the repository over a new one. Introduce a new pattern
  only when no existing one fits, and say why in the evidence.

## 6. Improve the paved path

When you or a human correct the same kind of mistake twice, the path is missing
something. Use the `gardener` skill to propose a fix at the strongest layer possible
(architecture, static analysis, CI, rule, skill, documentation, in that order).
`execute` lists new gardener proposals when a run completes; they are advisory, and
adopting one is a human decision taken with `paved gardener`. Propose; do not apply
structural changes to Core or project rules on your own.

When a person corrects you with something that holds for the project ("never edit an
applied migration", "labels come from the translation files"), do not keep it only in
your own notes or memory. Run `paved gardener correction --text "<their words>"
--evidence <file[:lines] | commit | url> --json` and present the decision it returns.
Paved drafts the rule, skips it when a rule already says it, and writes it to
`.paved/rules/` only when the person adopts it.

## Further reading (load on demand)

- `principles.md`: the principles behind these instructions.
- `lifecycle.md`: the task lifecycle phases and repository states.
- `workflows.md`: running a workflow: inputs, gates, approvals, failures, retries, run state.
- `verification/README.md`: check types, evidence and completion criteria.
