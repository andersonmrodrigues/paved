# Tool safety and permissions

Discovery is not permission. The Tool declares capabilities and required permissions;
the execution context must supply those permissions and satisfy every precondition.
Tool policy and project overrides are checked before selecting an implementation. A
binding cannot increase its Tool's allowed environments, timeout, permissions or retry
budget. Missing facts block execution rather than being guessed.

| Safety class | Meaning | Default policy |
|---|---|---|
| `read-only` | Observes state; no declared side effects or write permissions | Any declared environment after permission and precondition checks |
| `safe-mutation` | Bounded, reversible local changes | Local, CI or ephemeral only |
| `destructive` | Could lose data or materially change shared state | Human approval per invocation; one attempt |
| `high-impact` | External consequences even when technically reversible | Human approval per invocation; one attempt |

Environment kinds are the existing `local`, `ci`, `ephemeral`, `shared` and `production`.
An implementation must use a subset of the Tool's environments. A project Tool override
may only further restrict environments and timeouts, require approval, disable the Tool
or select an explicit compatible implementation. It cannot change safety or add
permissions. Project Tools can be edited directly; inherited Tools need an override
with owner, reason and optional target digest for drift review.

Retries are bounded (maximum three). The current policy retries only idempotent,
read-only or safe-mutation operations after a transient or environment failure. A
destructive, high-impact, non-idempotent or unknown-idempotency operation gets one
attempt. Timeouts and cancellation must preserve a `partial-execution` result when a
side effect may already have occurred. A dry run is supported only when a Tool and its
binding explicitly expose a genuine preview; a fake dry run must not be reported as
verification of the real action.

Inputs are validated before argv construction. Secret inputs are redacted from output
and evidence, and environment credential values are never embedded in Tool contracts.
Verification executables inherit only `PATH`, temporary-directory variables and
platform-required process variables. Other caller environment variables are not passed
to checks.
Output and error fields with secret-like names are redacted; a runner must also strip
authorization headers and sensitive values before storage. Redaction is a fallback,
not permission for a Tool to return secrets. Unknown permission, environment or
approval state is a blocked operation.
