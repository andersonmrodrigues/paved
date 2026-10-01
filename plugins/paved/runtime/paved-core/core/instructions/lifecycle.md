# Lifecycle

Two lifecycles matter to an agent: the lifecycle of a **task** (what you do, in order)
and the lifecycle of the **repository's Paved installation** (whether you can trust it).

## Task lifecycle

Every workflow is a selection of these phases, always in this order. A workflow may omit
a phase that does not apply, but `verification`, `evidence` and `completion` are never
omitted or skipped (the workflow schema enforces this).

| Phase | Question it answers | Leaves behind |
|---|---|---|
| `context` | What do I need to know, and what is the task exactly? | Task restated; relevant context located |
| `discovery` | Where in the code does this live, and how is it done today? | Affected files; existing patterns; unknowns |
| `planning` | What will I change, and how will I prove it? | Plan with intended claims and the checks for each |
| `implementation` | Make the change following existing patterns. | The change |
| `validation` | Does the change build and pass the fast, local checks? | Build, lint and targeted test results |
| `verification` | Does the change do what it claims, per the project's verification profile? | Check results for each claim |
| `evidence` | Can someone else confirm this without redoing the work? | `evidence.yaml` with claims, checks, artifacts, gaps |
| `review` | Does the change respect rules and patterns, and is anything unexplained? | Review findings resolved or recorded |
| `completion` | Are all completion criteria met? | Final status: complete, incomplete or blocked |

**Validation vs verification.** Validation is the inner loop you run while working: build,
type-check, lint, targeted tests. It catches mistakes early but is necessary, not
sufficient. Verification selects checks from the project's profile by the claims the
change makes and records their results as evidence. Plan the verification in `planning`:
deciding how to prove a change after writing it invites proving whatever was written.

**Gates.** A workflow phase can declare gates: conditions that must hold before the
phase ends. A gate with `approval` requires an explicit decision from a person; the
agent's own judgement does not satisfy it. A gate with `when` applies only when that
condition holds.

**Skipping and stopping.** A phase is skipped only when its `skip_when` condition holds,
and the reason is recorded. If a phase cannot be completed (missing input or access,
contradictory requirements, a rule that blocks a correct change), stop, record the
failure with its code, and report the task as `blocked` or `failed`. Do not skip ahead.
`workflows.md` has the failure codes, retry limits and approval categories.

## Repository states

Check the repository's state before starting a task. The CLI (`paved status`,
`paved doctor`) reports it; until the CLI exists, infer it from the files.

| State | How to recognise it | What to do |
|---|---|---|
| Not initialized | No `.paved/manifest.yaml` | Work normally, but tell the user Paved context is missing. Do not create `.paved/` unless asked (see the `repository-onboarding` skill). |
| Initialized, context missing | Manifest exists; `.paved/project/` absent or mostly `unknowns` | Rely on the code. Record what you learn as proposed context, not as fact. |
| Context stale | Generated documents list sources whose hashes no longer match | Treat stale context as a hint; verify against the code before relying on it. |
| Incompatible | Core version does not satisfy the manifest's `paved.core` range, or an unsupported `apiVersion` | Do not rely on Core contracts; report the incompatibility. |
| Overrides need review | An override's `target_sha256` no longer matches the Core or adapter content it modifies | Apply the target unmodified (no disabling, no lowered severity) until a human re-confirms the override. Additions (addenda, gates) still apply. |
| Ready | Manifest valid, context reviewed, verification profile present | Follow the paved path. |

The full install and update lifecycle is described in the Core repository under
`docs/concepts/repository-lifecycle.md`.
