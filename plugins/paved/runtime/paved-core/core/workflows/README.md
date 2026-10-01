# Workflows

A workflow carries one class of change through the task lifecycle. It decides which
phases run, which skills each phase activates, which checks prove the result and where a
human must decide; skills say how to do the work. Each workflow is a directory with:

- `workflow.yaml` (schema: `schemas/workflow.schema.yaml`): trigger (`change_type`),
  `version` and `status`, inputs, context, preconditions, rules, the phases in canonical
  order (goal, skills, tools, required and recommended check types, gates, `skip_when`,
  `retry`), required evidence kinds, outputs and completion criteria.
- `WORKFLOW.md`: guidance for the judgement calls (sections defined in
  `templates/workflow.md`, at most 80 lines).

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
| `performance` | performance | Latency, throughput or resource changes | |
| `incident` | incident | Production or a shared system is impaired now | Every mitigation (`production-change`) |
| `release` | release | Preparing, verifying and handing over a release | Publishing (`release`); incompatible changes |

Workflows do not invoke each other. An incident ends with a `follow-up` output; the
permanent fix runs as a `bug` workflow.

Projects never copy a Core workflow. Through `.paved/overrides/overrides.yaml` they can
`extend` one (add gates, require checks) or `disable` it, always with an owner and a
reason, targeting it by id (`core.<name>`). A project that needs a different procedure
disables the Core workflow and adds its own under `.paved/workflows/<name>/` with id
`project.<name>`. Adapters do not add workflows.
