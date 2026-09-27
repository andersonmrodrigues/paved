# Tool architecture

**Tool = capability; Skill = engineering behavior; Workflow = orchestration; Rule =
constraint; Verification = correctness check; Evidence = observed support.** A Tool's
qualified id and version name a stable capability. It declares purpose, typed inputs,
canonical output fields, preconditions, required permissions, environments, side effects,
safety, idempotency, retry and timeout limits, error vocabulary, evidence capture and
availability. The [Tool schema](../../schemas/tool.schema.yaml) carries no executable.
A [ToolImplementation](../../schemas/tool-implementation.schema.yaml) binds that
capability to a specific environment and executable. The binding may be supplied by
Core, an adapter or the project without changing the Tool's meaning.

The [generic catalog](../../core/tools/README.md) covers repository inspection, process
and runtime control, tests, database reads, observability, infrastructure inspection
and browser interaction. A catalog entry with no compatible binding is discoverable but
unavailable. Core does not assume a language, framework, provider, database or browser.

## Lifecycle

1. Discover the effective Tool set from the locked Core, selected adapters and project.
2. Validate the Tool, implementation and explicit project override.
3. Resolve one compatible binding for the Tool id and environment. Ambiguity blocks.
4. Validate typed inputs, environment, permissions, preconditions and approval.
5. Execute the binding with separate argv elements, a timeout and cancellation support.
6. Validate and sanitize the structured result; capture tool and environment versions,
   revision, timestamps, output digest, errors and referenced artifacts.
7. Convert the result into an Evidence CheckResult when a Verification Check invoked
   the Tool; the Evidence assessor still decides whether it supports the claim.

The current [library](../../cli/lib/tools.ts) implements steps 1–4 and the data capture
and conversion in steps 6–7. The executable runner, authenticated approvals and external
artifact storage remain CLI work. A caller must not treat a library-created record as
independent merely because it used the library: the recorder defaults to `agent`.

See [safety](tool-safety.md), [resolution](tool-resolution.md) and
[results](tool-results.md). [ADR 0017](../decisions/0017-tool-capability-and-resolution.md)
records the contract split; [ADR 0018](../decisions/0018-tool-safety-and-evidence.md)
records policy and evidence boundaries.
