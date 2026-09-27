# ADR 0017: Tool capabilities and implementation resolution

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

Earlier Tool documents combined a capability with its executable command. That coupled
reusable Core behavior to project technology, made adapter substitution unclear, and
made discovery look like permission. Skills, Workflows and Verification need stable
references that do not embed project commands.

## Decision

A versioned `Tool` is a capability contract: identity, purpose, structured inputs and
outputs, permissions, environments, preconditions, side effects, safety, idempotency,
bounded retry/timeout behavior, errors, availability and evidence capture. It contains no
executable. A separate versioned `ToolImplementation` binds a Tool id and compatible
contract range to an argv mechanism or a synthetic fixture.

Implementations may be supplied by Core, an adapter or a project. Resolution chooses one
compatible implementation deterministically, preferring the Tool's own namespace. An
adapter may implement an abstract Core capability when no own binding exists. A project
may replace an inherited binding only by an explicit, validated override. Missing or
ambiguous resolution fails closed; no command is inferred. Contracts are the registry
records; no duplicate registry format is introduced.

Tools provide capabilities. Skills describe engineering behavior. Workflows orchestrate
phases. Checks invoke Tool contracts. Rules constrain behavior. Evidence records
observations. Tools do not orchestrate other Tools; that remains Workflow work.

## Consequences

- Core catalogs remain technology-neutral, while adapters/projects own implementation
  details.
- Discovery can report availability and requirements without granting execution.
- Implementations and overrides can be schema-validated against stable contracts.
- The command runner is a later CLI responsibility; this phase provides validation,
  resolution, authorization-policy and evidence-capture library boundaries.
- Tool and binding SemVer are separate; binding metadata names the Tool version range it
  implements.

## Alternatives considered

- Keep commands on Tool documents: rejected because implementation would leak into the
  reusable capability contract.
- Treat Tool implementations as an adapter-only field: rejected because Core generic
  implementations and project-specific bindings need the same explicit contract.
- Add a separate Tool registry database: rejected because the existing manifest,
  qualified ids, document schemas and reference resolver already provide discovery.

## References

- [Tool schema](../../schemas/tool.schema.yaml)
- [ToolImplementation schema](../../schemas/tool-implementation.schema.yaml)
- [Tool architecture](../concepts/tools.md)
- [Resolution](../concepts/tool-resolution.md)
