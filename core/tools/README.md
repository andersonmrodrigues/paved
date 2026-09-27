# Tools

A Tool is a named capability with stable inputs, outputs, permissions and safety policy.
It does not contain a command. A ToolImplementation binds the capability to an executable
for Core, an adapter or a project. The generic catalog is discovered under `tools/`;
implemented Core bindings live under `../tool-implementations/`. Both use qualified ids
(`core.<group>.<name>`, `adapter-<name>.<group>.<name>`, `project.<group>.<name>`).

A Tool being discoverable does not authorize execution. The caller checks environment,
permissions, preconditions and independent approval before invoking a binding. A missing
binding yields `implementation-unavailable`, not an invented command. Bindings describe
an executable and argv elements; the runner must never interpolate inputs into a shell.
The Tool's safety and output meaning stay fixed when a binding changes.

| Safety | Default boundary |
|---|---|
| `read-only` | No side effects or write permissions |
| `safe-mutation` | Reversible, bounded changes in local, CI or ephemeral environments |
| `destructive` | Explicit human approval for each invocation; no automatic retry |
| `high-impact` | Explicit human approval for external consequences; no automatic retry |

The contract schema is `schemas/tool.schema.yaml`; the binding schema is
`schemas/tool-implementation.schema.yaml`. The project override schema permits only
restriction, disabling or explicit binding selection. It cannot increase permissions,
extend environments, lengthen timeouts or weaken approval. Technology-specific bindings
belong to adapters or project configuration. Core catalog entries without a binding
remain unavailable in discovery until an applicable implementation exists.

`core.repository.status`, `core.repository.diff` and `core.repository.history` express
source-control observations used by Core skills and workflows. Core supplies no binding
for them. A selected adapter may supply a compatible binding; otherwise resolution
blocks explicitly. Revision identifiers are opaque to Core.

Verification Checks reference a Tool id. A captured execution records the Tool id,
actual runtime version, implementation id and version, revision, environment, timestamps,
sanitized input/output digests and structured status. The result can be converted to the
existing Evidence CheckResult. The current CLI library implements discovery, resolution,
policy checks and capture; a command runner and independent identity verification remain
future CLI work.
