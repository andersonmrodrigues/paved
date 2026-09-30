# Skills

A skill is a reusable procedure an agent activates when a task matches it. Each skill is
a directory following the [Agent Skills specification](https://agentskills.io/specification),
plus a Paved contract file:

```text
<category>/<name>/
├── SKILL.md       # Agent Skills frontmatter (name, description) + the procedure
├── skill.yaml     # Paved contract: version, status, context, tools, rules,
│                  # dependencies, verification, evidence, supporting files
├── references/    # Optional detail, loaded when a step points to it
└── examples/      # Optional synthetic examples, loaded when a step points to them
```

- `SKILL.md` frontmatter uses only fields the Agent Skills spec defines, so any compatible
  agent can load the skill. Its body has the sections defined in `templates/skill.md`
  and stays under 150 lines.
- `skill.yaml` (schema: `schemas/skill.schema.yaml`) holds what tooling can check.
- Skills describe *how* to do a kind of work. They never contain project facts or
  technology specifics; they name the context area where the agent finds them.
- Generic failure handling and the procedure for unknowns are in
  `instructions/AGENTS.md`; skills list only their own failure modes.

## Catalog

All Core skills are `experimental`.

| Category | Skill | Version | Purpose |
|---|---|---|---|
| `bootstrap` | `repository-onboarding` | 0.2.0 | Set up or repair Paved in a repository |
| `discovery` | `context-discovery` | 0.2.0 | Understand a repository or the part a task touches |
| `development` | `feature-development` | 0.4.0 | Add or change behavior |
| | `frontend-design` | 0.1.0 | Plan and critique user-facing frontend interfaces |
| | `refactoring` | 0.2.0 | Change structure without changing behavior |
| | `prototyping` | 0.1.0 | Answer a feasibility question with throwaway code |
| `debugging` | `bug-investigation` | 0.3.0 | From symptom to verified fix |
| | `root-cause-analysis` | 0.2.0 | Find and confirm the cause of a defect |
| | `runtime-debugging` | 0.1.0 | Observe a running system safely |
| `testing` | `unit-testing` | 0.1.0 | Isolated tests for local logic |
| | `integration-testing` | 0.1.0 | Tests across real boundaries |
| | `e2e-testing` | 0.1.0 | Tests of critical user-visible flows |
| | `regression-testing` | 0.2.0 | A test that fails before a fix and passes after |
| `performance` | `profiling` | 0.2.0 | Measure, locate the bottleneck, change one thing |
| | `backend-performance` | 0.1.0 | Server-side latency, data access, caching, concurrency |
| | `frontend-performance` | 0.1.0 | Perceived load time, responsiveness, payload size |
| `security` | `security-review` | 0.2.0 | Review a change for security impact |
| | `threat-modeling` | 0.1.0 | Find threats in a design before it is built |
| `code-review` | `change-review` | 0.2.0 | Review a finished change across all dimensions |
| `gardener` | `gardener` | 0.2.0 | Turn recurring corrections into structural improvements |
| `decisions` | `decisions` | 0.1.0 | Relay Paved decisions without taking authorship from the user |
| `product` | `task-specification` | 0.2.0 | Write new tracker items or fill in existing ones, grounded in the repository |
| | `task-review` | 0.2.0 | Review an existing task or issue against the project's template and the repository |

A skill is identified by `<namespace>.<category>.<name>` (for example
`core.debugging.root-cause-analysis`); `SKILL.md` keeps the short `name` that agents
discover. Short names are unique among the skills active in a project, so a project skill
never shadows a Core skill. To customize a Core or adapter skill, `extend` it with an
addendum through `.paved/overrides/overrides.yaml`, or `disable` it with a reason and add
a project skill; do not copy it.

Each skill has its own SemVer version and a status (`experimental` below 1.0.0,
`stable` from 1.0.0, `deprecated` with a migration note). Bump rules, lifecycle and
validation are described in the Core documentation, `docs/concepts/skills.md`.
