# Skills

A skill is a reusable procedure an agent activates when a task matches it. Each skill is
a directory following the [Agent Skills specification](https://agentskills.io/specification),
plus a Paved contract file:

The `paved` router and eleven lean playbooks below are canonical skills: the existing
registry discovers them and plugin generation projects their instructions and references
for both hosts. Specialized skills remain available under their original names and ids;
load them only when their detailed procedure is needed. This is additive routing, not
a replacement for installed workflows, approval gates or specialized contracts.
The [plain Markdown index](lean/paved.md) is a source-reading convenience.

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
| `bootstrap` | `paved` | 0.1.0 | Lean task router |
| `bootstrap` | `setup` | 0.1.0 | Initialize and maintain Paved |
| `development` | `feature` | 0.1.0 | Short behavior-change playbook |
| `development` | `refactor` | 0.1.0 | Short behavior-preserving playbook |
| `development` | `design` | 0.1.0 | Design and experiment routing |
| `debugging` | `bug` | 0.1.0 | Short defect-repair playbook |
| `discovery` | `investigate` | 0.1.0 | Read-only investigation routing |
| `testing` | `verify` | 0.1.0 | Proof and verification gaps |
| `code-review` | `review` | 0.1.0 | Review and specialist lens routing |
| `code-review` | `ship` | 0.1.0 | Authorized delivery routing |
| `gardener` | `reflect` | 0.1.0 | Durable lesson capture |
| `product` | `task` | 0.1.0 | Handoff and mid-flow scope |
| `bootstrap` | `repository-onboarding` | 0.4.0 | Set up Paved and offer project-local app verification |
| `discovery` | `context-discovery` | 0.3.2 | Understand a repository or the part a task touches |
| `development` | `feature-development` | 0.8.0 | Add or change behavior |
| | `frontend-design` | 0.1.3 | Plan and critique user-facing frontend interfaces |
| | `refactoring` | 0.2.1 | Change structure without changing behavior |
| | `prototyping` | 0.1.1 | Answer a feasibility question with throwaway code |
| `debugging` | `bug-investigation` | 0.3.1 | From symptom to verified fix |
| | `root-cause-analysis` | 0.3.1 | Find and confirm the cause of a defect |
| | `runtime-debugging` | 0.1.1 | Observe a running system safely |
| `testing` | `unit-testing` | 0.1.1 | Isolated tests for local logic |
| | `integration-testing` | 0.1.1 | Tests across real boundaries |
| | `app-verification` | 0.2.0 | Create or maintain a project-local user-facing verification skill |
| | `e2e-testing` | 0.2.0 | Tests of critical user-visible flows using the project's verification guide |
| | `regression-testing` | 0.2.1 | A test that fails before a fix and passes after |
| | `harness-refinement` | 0.2.0 | Compare bounded alternative harness configurations using isolated runs and evidence |
| `performance` | `profiling` | 0.3.0 | Measure, locate the bottleneck, change one thing |
| | `backend-performance` | 0.1.2 | Server-side latency, data access, caching, concurrency |
| | `frontend-performance` | 0.1.2 | Perceived load time, responsiveness, payload size |
| `security` | `security-review` | 0.5.0 | Review a change for security impact |
| | `threat-modeling` | 0.1.1 | Find threats in a design before it is built |
| `code-review` | `change-review` | 0.7.0 | Review a finished change across all dimensions |
| | `change-delivery` | 0.1.0 | Open, triage and merge a reviewed change request while its evidence is fresh |
| `gardener` | `gardener` | 0.4.0 | Turn recurring corrections into structural improvements |
| `decisions` | `decisions` | 0.2.0 | Relay Paved decisions without taking authorship from the user, and ask only what cannot be observed |
| `product` | `task-specification` | 0.4.1 | Write new tracker items or fill in existing ones, grounded in the repository |
| | `task-review` | 0.4.1 | Review an existing task or issue against the project's template and the repository |

A skill is identified by `<namespace>.<category>.<name>` (for example
`core.debugging.root-cause-analysis`); `SKILL.md` keeps the short `name` that agents
discover. Short names are unique among the skills active in a project, so a project skill
never shadows a Core skill. To customize a Core or adapter skill, `extend` it with an
addendum through `.paved/overrides/overrides.yaml`, or `disable` it with a reason and add
a project skill; do not copy it.

Each skill has its own SemVer version and a status (`experimental` below 1.0.0,
`stable` from 1.0.0, `deprecated` with a migration note). Bump rules, lifecycle and
validation are described in the Core documentation, `docs/concepts/skills.md`.
