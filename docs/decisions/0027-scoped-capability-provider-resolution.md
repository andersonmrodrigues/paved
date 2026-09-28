# 0027. Scoped capability provider resolution

- **Status:** Accepted
- **Date:** 2026-09-28
- **Extends:** [0021](0021-adapter-capabilities-and-local-resolution.md)

## Context

ADR 0021 resolved each capability to one provider for the whole repository and
reported every capability with more than one provider as ambiguous. In a repository
with Java services beside TypeScript frontends, `init` therefore asked a human to
choose between two adapters that were each correct for their own directories, and
any single choice discarded half of the evidence.

## Decision

Detection records each adapter's scopes: the outermost directories of the files that
detected it, using content matches when there are any. Capability resolution keeps
one engine with this precedence: a manifest override (a string) > manifest scoped
selections (a list of `{ path, provider }`) > inference > ambiguous. Inference gives
each scope to the provider with the nearest enclosing scope. When providers tie on a
scope and one transitively requires another, the requiring (more specific) adapter
wins, so Angular declares that it requires TypeScript. Any other tie is ambiguous and
is reported for that scope only. Evidence is collected from each file by the provider
that governs its scope.

A decision is persisted in the tool-managed `paved.lock` only when more than one
adapter was a candidate or a selection was explicit. Each entry records its scope,
provider, source (`explicit`, `explicit-scoped` or `inferred`) and the detection files
behind it. Inferred decisions never enter the human-owned manifest. `status` reports a
lock whose decisions differ from the current resolution as stale until `update`
rewrites it.

## Consequences

Multi-stack repositories initialize without provider configuration when each stack
lives in its own directories. Single-provider repositories resolve exactly as before
and their locks gain no new section. Files outside every scope of a multi-provider
capability, such as a root `openapi.yaml` in a repository with no root build, are not
attributed to any provider. Adding a stack directory makes the lock stale, which is
intended, because the recorded provider decisions no longer describe the repository.

## Alternatives considered

- **Merge evidence from all providers.** Rejected: identical rules would double-count
  the same files, and the decision would be neither visible nor reviewable.
- **Write inferred selections into the manifest.** Rejected: that would turn tool
  inference into apparent human intent.
- **Rank providers by fixed technology preference.** Rejected: that is a
  technology-specific special case that the adapter contract cannot justify.

## References

- [Adapters](../concepts/adapters.md)
- [`schemas/lock.schema.yaml`](../../schemas/lock.schema.yaml)
