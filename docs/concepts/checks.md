# Checks

A [Check](../../schemas/check.schema.yaml) defines one objectively observable validation:
its purpose, type, tool, inputs, preconditions, expected result, timeout, environment,
outputs, failure handling, determinism and bounded retry policy. The definition does not
embed a command. Its [Tool](../../schemas/tool.schema.yaml) supplies the execution
mechanism; an adapter or project supplies technology-specific commands.

The [verification profile](../../schemas/verification.schema.yaml) lists available check
ids. Workflows and skills request check types; the plan resolves each type to a check id.
Core checks validate Paved schemas, references, provenance and completion contracts.
They do not imply that a consumer has a unit suite, browser or production environment.

Preconditions are evaluated before execution. `blocked` means a relevant check could not
run; `skipped` means it did not apply. Neither can be reported as passed. The check's
expected result must permit an objective verdict, such as an exit code or a measurement
against a project threshold. Results record the concrete tool version and environment.

Types are listed in the [registry](../../core/verification/registry.yaml). An architecture
check may enforce dependency direction or forbidden imports; a security check may run a
configured scanner; a runtime check may observe a health probe, browser flow or telemetry.
Formal checks can run model checkers or proof assistants, but are optional unless a
workflow explicitly requires them. A future browser adapter may execute navigate,
interact, observe, capture and assert steps and attach screenshots, DOM state or traces.
