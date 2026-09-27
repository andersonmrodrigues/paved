# Tool discovery and resolution

The existing qualified reference format identifies Tools:
`core.<group>.<name>`, `adapter-<name>.<group>.<name>` or
`project.<group>.<name>`. ToolImplementation documents have their own qualified ids and
reference a Tool id. The existing Core/adapter/project effective set and reference
resolver serve as the Tool registry; there is no second registry format. It indexes
contract metadata, binding source, version, environments and availability. The schema
registry validates both kinds; Skills, Workflows and Checks reference Tool ids, never
commands.

Resolution is deterministic: select the locked Tool version; reject a disabled or
unavailable Tool; filter bindings by exact Tool id, compatible contract range, source,
environment, timeout and availability. Prefer the binding from the Tool's own namespace.
If no own binding exists, one adapter binding may implement an abstract Core capability.
Multiple candidates are ambiguous and block. A project binding for an inherited Tool
requires an explicit `select-implementation` override. An override selects only a
binding; it cannot redefine capability meaning or weaken policy. No matching binding
means `implementation-unavailable`.

Adapters list Tool contracts and bindings in `adapter.yaml` `provides.tools` and
`provides.tool_implementations`; the adapter lock pins their version. Projects may add
their own Tool and binding under `.paved/tools/` and `.paved/tool-implementations/`.
Adapter and project bindings must declare the Tool version range they implement.
Tool contract versions follow SemVer: patch clarifies or fixes the contract without
changing its meaning, minor adds backward-compatible capability fields, and major
changes meaning, safety or required inputs. Implementations have independent versions;
a binding's `contract` range declares which Tool contract versions it supports.

A Tool cannot invoke another Tool directly in its binding. Workflows sequence
capabilities; a runner may combine results only through explicit Workflow phases and
their gates. This keeps failure propagation, timeouts and approvals visible rather than
creating a second workflow mechanism inside Tools.

The future [CLI command](../../cli/commands/tool/README.md) exposes list, inspect,
validate and doctor operations. Its diagnostics can feed Gardener proposals for missing
bindings, duplicated capabilities, obsolete versions, unsafe policies and repeated
failures.
