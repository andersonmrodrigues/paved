# Verification and evidence

An agent proposes a claim. A check defines an observable question. A tool executes it.
The execution produces observations and artifacts. An evidence record binds them to a
revision. The completion assessor recomputes the decision from that record. An agent's
assertion alone cannot support a claim.

```text
task → plan → check definition → tool execution → observation → evidence → completion
```

Testing is one verification mechanism. The [registry](registry.yaml) also defines
static analysis, architecture, security, performance, runtime, configuration and other
check types. Types express what a pass can support, not how strong a task must be.

## Plan and checks

Workflows and skills request `required` and `recommended` check **types**. A task's
evidence `plan` adds `optional` types and required evidence kinds. The project profile
(`.paved/verification/profile.yaml`) lists available check **ids**. Each id resolves to
a [Check](../../schemas/check.schema.yaml), which names a [Tool](../../schemas/tool.schema.yaml).
The tool holds the concrete command; a Core check never does. A missing required type is
recorded as a gap, but a gap cannot satisfy the requirement for task completion.

Before running, evaluate the check's preconditions. An unmet precondition yields
`blocked` when the check applies but cannot run, or `skipped` when it does not apply.
Neither is a pass. Keep the tool version, environment, revision, start time, observed
result and output reference. Run only checks relevant to the task, including any
additional checks required by rules or acceptance criteria.

## Evidence and completion

Use the [evidence template](../templates/evidence.yaml) and
[schema](../../schemas/evidence.schema.yaml). Every observation names an immutable
revision. If the working tree has changes, record its digest on the change and every
check. Keep secrets out of environment facts and output references. Keep large reports
outside the YAML and reference them through the canonical provenance source format.

The assessor in `cli/lib/evidence.ts` checks references, revision
binding, check definitions, retries, measurement thresholds, claim support, required
checks, rules and completion criteria. `complete` requires every required type to have a
passing check. `partially-verified` means some, but not all, required types passed; its
task status remains `incomplete` or `blocked`. Recommended omissions are warnings;
optional omissions are informational. Failed checks always block completion. Never
delete failed evidence when a later attempt succeeds.

`agent` results are self-reported, `paved` results are runner-captured, and `ci` results
come from CI. The profile or check may require a minimum recorder. Agent-recorded review
or manual observation does not support a claim. A passed build check cannot support a
behavior claim. See `docs/concepts/evidence.md` for status
semantics and retention.

Core checks under [checks/](checks/) validate Paved artifacts. Project commands and
thresholds belong in adapters or the consumer repository.
