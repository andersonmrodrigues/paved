# Repository signals

Where to look when investigating an unfamiliar repository, in the order that usually
answers the most with the least reading. Stop as soon as the goal is answered. Record
what each signal told you and which file said so; a signal you could not find is an
unknown, not a gap to fill.

| # | Question | Where to look | What it tells you |
|---|---|---|---|
| 1 | What is this repository for? | Root readme, contributor guide, agent instruction files, top-level directory names | Purpose, audience, how humans are expected to work in it |
| 2 | How is it structured? | Top-level directories; workspace or module definitions of the build system | Deployable units, libraries, where code, tests and configuration live |
| 3 | How is it built? | Build definition files at the root and in each module; lock files | The build system in use (match it against adapter `detect` signals), language versions, build entry points |
| 4 | What does it depend on? | Dependency manifests and lock files; vendored directories | Frameworks and libraries, which suggest adapters and patterns |
| 5 | How does it run? | Container or process definitions, start scripts, runtime configuration, deployment descriptors | Processes, ports, environments, external services it needs |
| 6 | How is it tested? | Test directories and naming conventions; test configuration; the test commands in the build definition | Test levels present (unit, integration, end-to-end), how to run one test |
| 7 | What does CI enforce? | CI pipeline definitions | The checks that really run, in which order, with which commands; the most reliable source for the verification profile |
| 8 | How is it configured? | Configuration files and their per-environment variants; environment variable documentation | What varies between environments; where secrets are referenced (never copy their values) |
| 9 | Where does behavior start? | Entry points: main programs, route or handler registrations, message consumers, scheduled jobs, command-line definitions, exported public interfaces | The starting points for following a code path |
| 10 | What architecture is intended? | Architecture decision records, dependency or layering checks, module boundaries in the build, package naming | Boundaries to respect; conventions to follow |
| 11 | What changed recently? | Version history of the area of interest | Active areas, recent regressions, who to ask |

## Reading the signals

- **Configuration beats documentation.** A CI definition that runs a command is stronger
  evidence than a readme that mentions it.
- **Absence is information.** No test directory for a module means untested code, not
  hidden tests. Record it.
- **Conflicts are recorded, not resolved.** When two signals disagree (the readme names
  one command and CI runs another), note both with their sources.
- **Technology-specific detail comes from adapters.** Once a technology is detected, the
  adapter's knowledge says where that technology keeps these signals.
