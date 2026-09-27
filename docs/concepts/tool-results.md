# Tool results, failures and Evidence

The canonical result envelope records Tool id, actual runtime version, implementation
id and version, status, typed error code, sanitized output, warnings, input/output
digests, environment, immutable revision and timestamps. A dirty working tree adds its
digest. Large reports, logs, traces and screenshots stay outside the result and are
referenced as Evidence artifacts using the existing provenance source model. Human text
is supplementary to declared JSON or YAML fields.

| Situation | Tool result | Verification consequence |
|---|---|---|
| Valid structured output | `succeeded` | Can become `passed` only if the Check expectation is met |
| Bad input, denied permission, unmet precondition, missing binding | `blocked` with a typed error | No passed Check |
| Timeout or execution failure | `timed-out` or `failed` | Error or failed Check; preserve output |
| Side effect may have occurred | `partial` / `partial-execution` | Inconclusive; inspect and recover before retry |
| Output violates declared fields | `failed` / `malformed-output` | Cannot be reported as passed |
| Evidence cannot be captured | `evidence-unavailable` | Completion cannot rely on the run |

The standard error vocabulary also includes unavailable dependency, environment
failure, transient failure, policy violation and unsupported capability. Error messages
must be sanitized before logging or Evidence. Retry applies only to allowed transient
errors within the Tool's bound; failed attempts remain visible.

A Verification Check references a Tool contract. The [capture library](../../cli/lib/tools.ts)
produces a structured Tool result and maps it to the existing Evidence `CheckResult`:
Tool id/version, status, observations, revision, environment, timestamps and output
digest. Evidence still records the Check definition, claim links, artifact sources and
completion decision; Tools do not create a second Evidence format. The recorder is
`agent` by default. `ci` records require a run URL, but authenticating CI or human
identity is future runner work.
