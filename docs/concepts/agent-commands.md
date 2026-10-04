# Agent command reference

Paved defines one agent-neutral command contract and projects it into supported
agent-native command surfaces. Through the installed plugin, Claude Code exposes
`/paved:intent` and Codex exposes the `paved:intent` skill; the project-local
Codex projection uses `$paved-intent`. Names are presentation syntax only: all
resolve the same stable `paved.<name>` contract.

The contract is discoverable with `paved agent commands --json`. Resolve an
individual command and its current availability with
`paved agent command <name> --json`. The result includes its input/output
shape, required context, side effects, lifecycle states, and actionable
unavailability reason. Discovery is read-only; native
commands invoke the packaged runtime through a project-local bootstrap launcher.

Paved projects seven agent commands:

| Command | Purpose and input | Lifecycle / relevant context | Side effects and output | Failure behavior |
|---|---|---|---|---|
| `init` | Bootstrap and initialize Paved; no input | `UNINITIALIZED`; repository evidence | Acquires a pinned runtime, initializes `.paved/`, asks which detected checks gate verification, which detected module test commands workflows run, which observed conventions become rules, maintains the `AGENTS.md` block, then generates context | Never resets existing state; malformed or unverified runtime state fails. |
| `status` | Inspect Paved state and offer repairs; answer a repair decision with `--answer` | Any lifecycle; manifest and lock | Lifecycle, lock, adapters, context, verification profile, open runs, diagnostics and repair decisions. Read-only unless the user answers a repair decision | Reports missing/invalid state without writes; no repair is applied without the user's answer. |
| `intent` | The user's request, verbatim; `--workflow <feature\|bug\|refactor> --because "<evidence>"` when the evidence shows the kind of change | `RESOLVED`, `GENERATED`, `VALIDATED`, or `READY`; project context, rules and the Core workflows | Creates the run and its Intent document, settles the classification (or asks the user), and runs `context` and `discovery`, including a bug's failing regression test and a refactor's baseline | A workflow without evidence is refused; uncertainty becomes a decision; Paved never guesses. |
| `plan` | The run, when several are open (`--run <id>`) | Same development states; the run's workflow and verification profile | Records the plan at `.paved/documents/plans/<run-id>.md`, opens it in the preview, and records the approval the user gives in the conversation (`--approve`) | A changed plan needs a new approval; only the user approves. |
| `execute` | The run, when several are open (`--run <id>`) | Same development states; the run's workflow, verification profile and tool bindings | Implementation, tests, verification, evidence, review in the preview, completion, and new gardener proposals | A run without an approved plan is refused; failed tests or verification fail the phase within bounded retries; gardener proposals never block completion. |
| `preview` | Review a Markdown file, or a folder of them, with selected-text comments | Same development states; Markdown file or folder | Loopback preview and comments with received, working and resolved status | A comment on a stale document is refused; the preview approves nothing. |
| `update` | Update local Core/adapters/inputs; no input | Initialized lifecycle; manifest and lock | Uses the existing safe update transaction, then rewrites an outdated managed `AGENTS.md` block | Unknown compatibility, migrations and ownership conflicts stop unsafe writes; remote update is unsupported. |

Removed agent commands (Core 2.0): `feature`, `fix`, `refactor`, the 1.x `plan` (an alias
of `feature`; the 2.0 `plan` is the new step), `debug`, `implement`, `review`, `test`,
`verify`, `doctor` and `gardener`. `paved agent install` and `paved agent update` delete the
Paved-generated files of removed commands; files without the Paved header are never
touched. See [migrating to 2.0](../getting-started/migrating-to-2.md).

CLI subcommands kept: `test`, `verify`, `doctor` and `gardener` are not projected to agents
but remain CLI subcommands for CI, the launcher and the runtime itself; `decision`, `tool`,
`generate` and `agent` are unchanged.

Each command contract also reports its interaction mode, decision source (`runtime` or
`agent`) and answer channel (`relayed` or `human-authored`). Conversational commands
return questions at top-level `decisions[]`; agents present them and resume the same
command with the user's answer. See [conversational decisions](decisions.md) and the
[canonical decision skill](../../core/skills/decisions/decisions/SKILL.md).

## Steps and phase ownership

`intent`, `plan` and `execute` persist one `WorkflowRun` under `.paved/generated/runs/`,
and each owns a fixed range of its workflow's phases:

| Step | Phases |
|---|---|
| `intent` | classification, `context`, `discovery` |
| `plan` | `planning` |
| `execute` | `implementation` through `completion` |

Within its range a step advances with `--advance`, `--note`, `--evidence` and `--answer`. A
step invoked outside its range returns `PAVED_WORKFLOW_STEP_OUT_OF_RANGE` and names the
step that owns the run's current phase. `execute` refuses a run whose plan is not
approved. The agent supplies observations and code changes; the runtime checks phase
order and plan approval, calls the testing Tool, runs authoritative Paved verification,
and requires matching workflow evidence before completion. When those return decisions
of their own, the step returns them and passes the user's answers through when it resumes.

A run created by Paved 1.x (`feature-…`, `fix-…`, `refactor-…`) is resumed by the step that
owns its current phase.

## Selecting the run

`plan` and `execute`, and `intent` without a request, take `--run <id>`. Without it they act
on the only open run. With several open runs, the runtime raises a decision listing them
(request, workflow and current phase) with no recommendation; it never picks one.

## The CLI `test` subcommand

The CLI `test` operation invokes every test Tool adopted from detected modules,
or one manually declared testing Tool, using the existing Tool contracts,
ToolImplementation resolver and bounded process runner. It records sanitized
evidence per command as incomplete/unverified; `verify`
continues to execute only checks configured in the project verification
profile. The workflow steps call the same testing Tool during `discovery` and `validation`.
For Maven projects with local dependencies, the Java adapter orders the modules
and installs consumed artifacts before downstream tests in both testing suites
and newly adopted verification profiles.

## Distribution status

Paved is distributed as a native Codex and Claude Code plugin through
GitHub-backed marketplace distribution from this repository; see
[Installing the Paved plugin](../getting-started/installing-the-plugin.md). The
plugin bundles the `paved-core` runtime unpacked, so activation needs no registry.
`paved-core` is not published to npm and the plugin is not listed in a public
plugin directory; the launcher's registry path applies only to a lock that pins a
runtime the plugin does not bundle.
