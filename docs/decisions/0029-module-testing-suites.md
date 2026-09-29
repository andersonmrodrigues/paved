# 0029. Module testing suites

- **Status:** Accepted
- **Date:** 2026-09-29

## Context

Repository check detection already preserves the directory of each Maven or npm
build definition, and verification can adopt checks from several directories.
The development testing path instead asked for one test command and created one
`testing-run` Tool. In a monorepo, this leaves other modules outside `paved test`
and the workflow validation phase.

## Decision

When several test commands are detected, offer an explicit option to adopt all
of them. Generate a separate project Tool and ToolImplementation for each
selected directory. Resolve that generated set as one testing suite and run
every member in a deterministic order. A failure in any member fails the
overall test operation; each executed member retains its own evidence. Keep
one manually declared testing Tool and its ambiguity decision supported.
For Maven projects, inspect local POM coordinates and dependencies, order
dependent modules after their dependencies, and run `mvn install` for a module
whose artifact another selected module consumes. The install lifecycle runs
that module's tests and makes its artifact available to downstream `mvn test`
commands. Maven-specific graph parsing belongs in the Java adapter.
The same dependency order and Maven lifecycle are used when generating the
project verification profile, so workflow verification follows testing.

## Consequences

`paved test` without a module selector covers every adopted module, including
when called from a development workflow. The result carries all Tool results
and evidence paths while retaining the existing singular fields for callers
that need one representative result. A missing binding in a generated suite
blocks the suite instead of silently reducing coverage. Module dependency
cycles and duplicate local coordinates block resolution. Paved does not infer
relationships to external dependencies.

## Alternatives considered

- **Keep one selected command.** Rejected because it cannot cover independent
  modules in one workflow validation step.
- **Generate one shell command that chains all tests.** Rejected because it
  hides per-module authorization, process outcomes, and evidence behind a shell.
- **Run `mvn test` in directory order.** Rejected because downstream projects
  can require an upstream artifact in the local Maven repository.

## References

- [Agent commands](../concepts/agent-commands.md)
- [Tool capability and resolution](0017-tool-capability-and-resolution.md)
