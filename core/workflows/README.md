# Workflows

A workflow carries one class of change through the task lifecycle. It decides which
phases run, which skills each phase activates, which checks prove the result and where a
human must decide; skills say how to do the work. Each workflow is a directory with:

- `workflow.yaml` (schema: `schemas/workflow.schema.yaml`): trigger (`change_type`),
  `version` and `status`, inputs, context, preconditions, rules, the phases in canonical
  order (goal, skills, tools, required and recommended check types, gates, `skip_when`,
  `retry`, optional `fragments` and `tool_policies`), an optional `autonomy.default_profile`,
  workflow-local Tool policy definitions, required evidence kinds, outputs and completion criteria.
- `WORKFLOW.md`: guidance for the judgement calls (sections defined in
  `templates/workflow.md`, at most 80 lines).

Reusable phase guidance lives in `core/workflow-fragments/<name>/` as `fragment.yaml`
and `FRAGMENT.md` (schema: `schemas/workflow-fragment.schema.yaml`); see the
catalog in `docs/catalog.md`. Include it with
`phases[].fragments[] {id, with}`. Bind every declared input exactly once with a nonblank
string; only exact `{{ inputs.<id> }}` placeholders are supported. Fragment skills and
required Tools compose with the phase; fragments add no phases, gates or nested runs.

The `docs/concepts/workflows.md` guide defines autonomy profiles and
phase-selected Tool policies. Both are optional: omission preserves existing behavior.
Neither relaxes gates, verification, evidence, Tool safety or host permissions. Policy
validation rejects unknown references, conflicting actions and denied required Tools
before dispatch; integrations apply the projected actions within host permissions.

How any workflow is run (preconditions, gates and approvals, failure codes, retries,
completion, the run record) is in `instructions/workflows.md`. The canonical phase order
is defined in `instructions/lifecycle.md`:

```text
context → discovery → planning → implementation → validation → verification → evidence → review → completion
```

A workflow may omit phases that do not apply. `verification`, `evidence` and
`completion` can never be omitted or skipped; other phases are skipped only when their
`skip_when` holds.

| Workflow | Change type | Use for | Human approval |
|---|---|---|---|
| `feature` | feature | New or changed behavior | Crossing an architectural boundary |
| `bug` | bug-fix | Behavior that differs from what is intended | |
| `refactor` | refactor | Structure changes with no behavior change | Refactoring code no test pins |
| `performance` | performance | A measured metric to improve, behavior unchanged | The plan, after a recorded baseline |
| `investigation` | investigation | A question answered with cited sources; changes nothing | |

A workflow without an `implementation` phase is read-only: every Tool it can reach,
directly or through a skill, must be `read-only`, and its run ends when its source is
unchanged. `investigation` is the Core's. A change it recommends starts a new intent.
A new performance budget is a `feature`. Workflows do not invoke each other.

Projects never copy a Core workflow. Through `.paved/overrides/overrides.yaml` they can
`extend` one (add gates, require checks) or `disable` it, always with an owner and a
reason, targeting it by id (`core.<name>`). A project that needs a different procedure
disables the Core workflow and adds its own under `.paved/workflows/<name>/` with id
`project.<name>`. Adapters do not add workflows.
