---
name: integration-testing
description: >-
  Test a component with its real collaborators or local stand-ins through the repository's integration setup. Use when behavior across a component boundary cannot be proven with isolated unit tests.
---

# Integration testing

## When to use

When a claim concerns a boundary: data written and read back, a message published and
consumed, a remote contract honored, configuration actually loaded, a transaction
committed or rolled back.

## Required context

The verification profile (how integration tests run, what they need). Useful: the
integrations context (which external systems exist and how the project stands them up
for tests) and the technology context.

## Preconditions

- The project has a way to run integration tests. If the profile marks `integration` as
  unavailable, record a gap; do not build test infrastructure unasked.
- The claim names the boundary under test.

## Procedure

1. **Discover the existing setup**: where integration tests live, how collaborators are
   started (local instances, containers, in-memory stand-ins, recorded responses), how
   data is seeded and cleaned up, and how tests are kept apart from unit tests.
2. **Test through the real boundary.** Use real collaborators or the project's accepted
   stand-ins; a double for the very boundary under test defeats the purpose.
3. **Own the data.** Each test creates what it needs and does not depend on data from
   another test or on execution order. Clean up the same way sibling tests do.
4. **Cover the failure side of the boundary**: the collaborator is unavailable, slow,
   returns an error or malformed data, or a constraint is violated.
5. **Keep test configuration separate** from real configuration. Credentials for test
   collaborators come from the environment or the test setup, never from real
   environments and never written into files.
6. **Run the tests twice**: an unstable result on the second run means shared state or
   timing problems to fix now.

## Tools

None. The command comes from the verification profile.

## Rules

`core.architecture.follow-existing-patterns`: reuse the existing setup rather than
starting collaborators a new way. `core.security.no-secrets-in-source` applies to test
configuration and seeded data.

## Verification

Required: `integration`.

## Evidence

A check result for the integration tests that cover the claim.

## Completion criteria

- Each boundary claim has a test that crosses the real boundary.
- Tests pass on repeated runs and in any order.

## Failure modes

| Failure | Signal | Response |
|---|---|---|
| Unit test in disguise | The boundary under test is replaced by a double | Use the real collaborator or its accepted stand-in |
| Order dependence | Tests pass alone and fail together | Give each test its own data |
| Environment leak | Tests reach a shared or real environment | Stop; point them at the test setup |
| Slow suite | New tests add large startup cost | Reuse the existing shared setup |

## References

None.
