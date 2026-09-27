# `paved verify` and `paved evidence`

These commands are contracts. The CLI runner is not implemented yet; `cli/lib/` already
provides schema, reference, check and evidence assessment functions.

## `paved verify`

- With no selector, resolve applicable workflow and skill requirements against the
  verification profile, then run all required checks and relevant recommended checks.
- `--check <id>` selects one check definition; `--workflow <id>` selects a workflow;
  `--profile <path>` selects a profile. `--changed <path...>` may narrow checks whose
  `applies_to` patterns do not match. Explicitly required checks cannot be silently
  removed by this filter.
- Resolve check → tool and validate tool safety, declared inputs, timeout and
  preconditions before execution. Capture tool version, revision, working tree digest
  when dirty, environment, status, observations, attempts and output artifact references.
- Write the evidence record under `.paved/generated/evidence/`. A missing required
  check becomes a gap and a nonzero completion result, not a pass. Preserve failed
  results and bounded retry history.
- `--evidence <file>` is a read-only compatibility alias for
  `paved evidence validate <file>`.

## `paved evidence`

- `paved evidence validate <file>`: check schema, references, revision binding,
  provenance and semantic consistency; recompute completion with the profile policy.
  `--against completion|workflow|skills` narrows the reported assessment while still
  validating the record's structure.
- `paved evidence show <file>`: report checks, gaps, claim support, verification level,
  blocking reasons, warnings and artifact locations.
- `paved evidence list`: list records in the configured evidence locations by
  revision and retention class.
- A record whose stated completion exceeds the computed decision is invalid. A failed
  result is kept for debugging. Artifact content hashes and external identities require
  a future runner or CI integration to verify.

Both commands support `--json` and follow the [CLI exit codes](../../README.md):
0 for successful validation or completed verification, 1 for verification or document
problems, 2 for usage errors, 3 for environment errors. Writing commands support
`--dry-run`.
