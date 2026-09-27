# Verification levels

Paved reports a result level rather than a universal ladder of check types:

| Level | Meaning |
|---|---|
| `unverified` | No required check type has a passing result |
| `partially-verified` | At least one, but not all, required types have passing results |
| `verified` | Every required type has a passing result |

The plan's required checks determine rigor explicitly. A documentation workflow can
require configuration or reference validation; a feature workflow can require tests and
runtime observations; a release workflow can require stronger checks and approval.
No single level implies that every mechanism has run. An optional formal or performance
check does not become mandatory simply because it exists. Required gaps remain visible
and prevent completion. Recommended omissions produce warnings; optional omissions are
informational. See [verification](verification.md).
