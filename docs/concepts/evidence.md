# Evidence

An [Evidence record](../../schemas/evidence.schema.yaml) binds task claims, the
verification plan, check executions, observations and artifacts to one revision. A claim
names its supporting check result or artifact; the [registry](../../core/verification/registry.yaml)
limits which kinds can support which claims. An agent assertion alone is not support.

Every check result records its definition id, type, tool id and version, status, recorder,
revision and time. Environment kind is required by the schema when an environment is
recorded; OS, image, dependency digest and configuration profile are captured when known
or required by the check. Do not include secret values. A changed working tree needs its
digest on the subject and on each check execution. Results from another revision are
rejected. Artifacts use the canonical provenance `source` object and reference reports,
logs, screenshots or traces rather than embedding them.

| Check status | Meaning | Supports a claim? |
|---|---|---|
| `passed` | Executed and met the declared expectation | Yes, if its type can support the claim |
| `failed` | Executed and violated the expectation | No; blocks completion |
| `error` | Execution failed without a verdict | No; blocks completion |
| `blocked` | Applicable, but a precondition prevented execution | No |
| `skipped` | Did not apply | No |
| `inconclusive` | Ran, but cannot decide; includes disagreeing retries | No |

Completion status (`complete`, `incomplete`, `blocked`) is separate from verification
level (`verified`, `partially-verified`, `unverified`). The assessor recomputes both from
the record. A partial level never authorizes completion of an unmet required check.
The recorder (`agent`, `paved`, `ci`) describes independence; project policy may set a
minimum. Agent-recorded review and manual-observation statements support nothing.

Working records and small outputs live in `.paved/generated/evidence/`; retained copies
may live in `.paved/verification/evidence/` or with a change request, CI run or release.
The `retention` field distinguishes local, change, release and audit lifetimes. Large
artifacts belong in external or CI storage with a stable location and digest where
appropriate. Failed records are preserved; a later run creates a new record and may
name the earlier one in `supersedes`.
