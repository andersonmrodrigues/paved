# 0001. Core vs Project Context

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

An agent needs two kinds of knowledge: how to work (universal) and how this repository
works (specific). Putting both in one place either leaks project facts into a shared
framework or forces every project to copy and maintain the framework.

## Decision

- The Core holds only knowledge true for every well-built repository: instructions,
  principles, lifecycle, skills, workflows, rules, tool and verification models, schemas.
- Project Context lives in the consumer's `.paved/project/`, versioned with its code and
  reviewed by its owners.
- Technology knowledge goes into adapters, never into either.
- Test for placement: if a sentence would be false for some well-built repository, it
  does not belong in the Core.

## Consequences

- The Core can be shared by any number of repositories without forking.
- Project knowledge changes in the same commits as the code it describes.
- A Core that "knows nothing" is less helpful out of the box; generators and adapters
  compensate.
- Domain agnosticism of Core prose can only be checked by review and keyword scans.

## Alternatives considered

- **Central knowledge base for all projects.** Rejected: goes stale, not reviewed by
  code owners, and one project's context leaks into another's agents.
- **Core copied into each repository.** Rejected: copies stop receiving fixes (the
  problem principle 7 addresses).

## References

- [agents.md](https://agents.md/): repository-local Markdown instructions
- `core/instructions/principles.md` (principles 1 and 2)
