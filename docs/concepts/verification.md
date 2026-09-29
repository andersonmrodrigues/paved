# Verification architecture

Paved separates an agent claim from observed evidence. The task produces a verification
plan; each required type resolves to a check definition in the project's profile. A check
names a tool, and the tool executes it. The run produces observations and artifact
references bound to the revision. The assessor recomputes completion from the record.

```text
Task → Plan → Check → Tool execution → Observation → Evidence → Completion
```

Testing is one verification mechanism. Static analysis, architecture, security,
performance, runtime, deployment, observability, configuration and formal checks use the
same model. The [registry](../../core/verification/registry.yaml) records what each type
can support. A build pass does not support a behavior claim.

A workflow or skill declares required and recommended check types. The evidence plan
adds optional types, acceptance criteria and required evidence kinds. The
[profile](../../schemas/verification.schema.yaml) lists available check ids; their
[definitions](checks.md) name tools and expected results. The Core contains no consumer
commands or thresholds. Project tools and adapters supply the execution mechanism.

An [evidence record](evidence.md) distinguishes the claimant, observer and assessor.
`agent` results are self-reported; `paved` and `ci` results are captured by other
processes. A project may require a minimum recorder. Every observation names its
revision. The assessor checks references, provenance, results, required types, rules and
criteria. It never asks the agent whether the task is done. Human gates remain separate
workflow decisions.

[Levels](verification-levels.md) report how many required types passed.
[Failure semantics](verification-failure.md) keep blocked, skipped, failed, error and
inconclusive distinct. [Determinism](verification-determinism.md) explains environment
capture, retries and measurements. Decision records:
[ADR 0005](../decisions/0005-verification-evidence-separation.md) and
[ADR 0016](../decisions/0016-verification-check-and-completion.md).

Paved can verify that support has the right type and revision. It cannot prove that a
test assertion fully exercises a claim, authenticate a human approval, or make an
agent-reported result independent. Those remain review and runner responsibilities.

When `init` detects eligible checks, Paved can offer them as a material profile-adoption
decision and write `.paved/verification/profile.yaml` after the answer. Choosing a check
only configures what Paved will run; it does not prove that the check passed. A later
`verify` invocation executes the configured Tools and records evidence. Existing valid
profiles remain supported as already-decided project configuration. See
[conversational decisions](decisions.md).
