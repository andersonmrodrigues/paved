# Tests

Paved tests its own contracts. Run everything with:

```bash
npm run check    # type check (tsc, strict) + all tests
npm test         # tests only (node:test, TypeScript run natively by Node >= 22.18)
```

| Suite | What it proves |
|---|---|
| `schemas/` | Every schema compiles in Ajv strict mode, is registered in the Core manifest, has valid and invalid fixtures, and accepts/rejects them for the stated reason; shared definitions never reference document schemas; `apiVersion` compatibility (missing, malformed, newer, older); YAML templates validate; the check-type enum matches the verification registry. |
| `skills/` | Every Core skill has Agent Skills-compliant frontmatter, all required sections, a valid `skill.yaml` whose id matches its location, and exactly the supporting files it lists. Every category has a skill. Skills pass the quality checks (size, genericity, contract mentioned in the body, no copied rules), the dependency graph is acyclic, no sentence repeats across skills, and no required check type proves nothing. Fixtures prove each quality check fails when it should, and that evidence is assessed against its producer skills. |
| `workflows/` | Every workflow is valid, identified by its directory, and passes `assessWorkflowQuality`; the canonical order equals `lifecycle.md`; quality, run and workflow-evidence fixtures produce exactly the stated problems. |
| `generators/` | Every generator contract is valid, documents the required aspects, has an acyclic dependency graph, **writes only to generated-reviewed or disposable paths** of the consumer layout, and declares inline metadata only where the output schema has provenance. |
| `core/` | Manifest validity and version consistency, consumer ownership model, component boundaries, rule and tool validity with ids matching paths, reference resolution and visibility across Core content, templates and fixtures, evidence semantics (a build cannot prove behavior; self-reported reviews prove nothing; the recorder policy), and that every relative Markdown link resolves. |
| `provenance/` | Cited sources are declared and managed blocks are well formed, in templates and fixtures. |
| `verification/` | Synthetic Check, profile and Evidence fixtures validate; completion status and verification level are assessed for success, failure, blocked, skipped, inconclusive, partial, flaky, performance and runtime results. A result whose exit code contradicts its Check is rejected. |
| `tools/` | Tool and binding contracts validate; discovery does not authorize execution; safety, permissions, preconditions, input/output contracts, resolution, explicit overrides, bounded retries, redaction and revision-bound Evidence conversion are checked with synthetic implementations. |
| `atomic-write.test.ts` | Persisted files replace atomically, failed replacement preserves existing destination state, and temporary write artifacts are cleaned up. |
| `helpers.test.ts` | Temporary repository identities remain valid consumer slugs, fixture copies are independent, and registered temporary directories are removed. |
| `operation-lock.test.ts` | Mutating consumer operations share an exclusive lock, release it after use, and fail closed on stale lock evidence. |
| `workbench/` | The local dashboard is token-protected and loopback-only, reads current workflow runs, accepts only minimal hashed hook activity, and starts/stops through the CLI. |
| `performance/` | Exercises init, update, generate, verify, status, doctor and Gardener in a synthetic consumer and prints an informational duration baseline without machine-specific thresholds. |
| `fixtures/` | Inputs for the suites above (see its README). |

## Test taxonomy and current limits

The existing suites combine these behavioral categories rather than splitting them into
parallel test frameworks:

| Category | Existing coverage |
|---|---|
| Contract | Schemas, adapters, generator contracts, Tools, workflows and Core boundaries. |
| Component | Generator Runtime, verification engine/runner, provenance and Gardener behavior. |
| Integration / end-to-end | CLI dispatch and executable tests, consumer lifecycle and command side effects. |
| Failure / recovery | Invalid state, failed checks, staged update rejection, directory-swap rollback, unfinished-backup detection, ownership conflicts, stale operation locks, safe dry runs and atomic file replacement. |
| Determinism / idempotency | Repeated generation and Gardener analysis, ordered adapter/generator resolution and stable evidence. |
| Concurrency | Generation, verification and update acquire one consumer-level exclusive lock; lock collisions fail with `PAVED_OPERATION_IN_PROGRESS`. Gardener is read-only and may observe either side of the atomic update swap rather than a cross-file snapshot. |
| Regression | Added beside the capability that owns the behavior, rather than in a duplicate regression framework. |

Automatic schema migrations and remote distribution are not implemented, so there is no
migration engine or remote compatibility matrix to exercise. The suite uses synthetic
consumer repositories; an Apecatus checkout is not required or bundled. Hard process
termination is not simulated. Exclusive lock acquisition and collision behavior are
tested deterministically; no timing-sensitive multi-process stress test is used.
Transaction tests cover controlled stage failures and synchronous state-change detection.

## Focused runs and temporary repositories

Run a focused suite directly with Node's test runner, for example:

```bash
node --test tests/schemas/schemas.test.ts
node --test tests/generators/runtime.test.ts
node --test tests/cli/lifecycle.test.ts
node --test tests/cli/commands.test.ts
node --test tests/gardener/gardener.test.ts
node --test tests/atomic-write.test.ts tests/operation-lock.test.ts
node --test tests/performance/baseline.test.ts
```

The performance test reports observed elapsed time as TAP diagnostics; it is not a
benchmark gate and deliberately sets no machine-specific pass/fail threshold.

`tests/helpers.ts` provides temporary directories and fixture copies, defaulting to the
operating system's temporary directory. Suites register cleanup after each test, so a
failed assertion also removes its consumer repository. Git path assertions resolve
temporary paths before comparison to account for platform-level symlinked temp roots.
Static inputs remain under `tests/fixtures/` and are copied before a test modifies them.

When a test here fails after a content change, the content usually broke a contract. Fix
the content, or change the contract deliberately (schema + changelog + version, see
`docs/concepts/versioning.md`).
