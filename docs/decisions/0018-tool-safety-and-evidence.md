# ADR 0018: Tool safety boundaries and evidence capture

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

An executable capability may read or mutate local state, destroy data or cause external
consequences. Merely listing a Tool to an agent cannot be treated as authorization.
Verification also needs observed execution metadata while preserving the Evidence model's
revision binding and distinction between independent observation and agent assertion.

## Decision

Every Tool declares one safety class: `read-only`, `safe-mutation`, `destructive` or
`high-impact`. It also declares permissions, allowed environments, side effects,
idempotency, preconditions, timeout, bounded retry and error classes. Unknown policy
state fails closed. Read-only Tools cannot declare write permissions or side effects.
Destructive and high-impact Tools require a separate human approval per invocation and
cannot retry automatically. Retries are limited to eligible idempotent read-only or
safe-mutation operations after transient/environment failures.

The policy library authorizes before implementation execution. Project overrides may
disable, restrict policy or explicitly select a compatible implementation; they cannot
weaken the capability contract. Executable bindings use argv elements, not shell
interpolation. Sensitive input and output data must be redacted before logs or evidence.

Tool execution metadata is converted to the existing Evidence CheckResult only when it
is bound to a revision and has valid provenance and sanitized observations. Tool
execution success by itself does not prove a Verification check passed; check-specific
expected/observed result semantics must also match. The Evidence assessor remains the
sole completion decision authority. Agent-recorded execution remains agent evidence and
cannot impersonate a runner, CI system or human.

## Consequences

- Dangerous operations fail closed until an authenticated approval and a capable runner
  exist.
- Failed and partial execution data can be retained for diagnosis without claiming a
  pass.
- Secrets are excluded from Tool contracts and sanitized from captured values.
- The present CLI library can validate policy and construct records, but authenticated
  approval, process isolation and execution are future work and must be added before a
  production runner is claimed.

## Alternatives considered

- Treat discoverability as permission: rejected; it permits implicit privilege
  escalation.
- Allow retries until success: rejected; destructive and non-idempotent operations can
  repeat side effects and flaky results must remain visible.
- Let each Tool define its own Evidence format: rejected because Phase 06 already owns
  one revision-bound Evidence contract and deterministic completion assessor.

## References

- [Tool safety](../concepts/tool-safety.md)
- [Tool results and Evidence](../concepts/tool-results.md)
- [Evidence schema](../../schemas/evidence.schema.yaml)
- [Verification architecture](../concepts/verification.md)
