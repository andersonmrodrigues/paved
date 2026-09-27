# 0011. Tooling stack

- **Status:** Accepted
- **Date:** 2026-09-27

## Context

The Core needs tooling to validate its own contracts now and a CLI later.

## Decision

- Node.js ≥ 22.18 running TypeScript directly (type stripping), no build step.
- `node:test`, TypeScript strict type check, Ajv 2020 and `yaml` as the only runtime
  dependencies.
- No linter until there is a reason for one.

## Consequences

- Small dependency surface; `npm run check` is the whole verification.
- Type stripping restricts TypeScript to erasable syntax.

## Alternatives considered

- **Other runtimes.** Chosen by the maintainer during the bootstrap.

## References

- [Node.js TypeScript support](https://nodejs.org/api/typescript.html)
