# Agent command reference

Paved defines one agent-neutral command contract and projects it into supported
agent-native command surfaces. Through the installed plugin, Claude Code exposes
`/paved:feature` and Codex exposes the `paved:feature` skill; the project-local
Codex projection uses `$paved-feature`. Names are presentation syntax only: all
resolve the same stable `paved.<name>` contract.

The contract is discoverable with `paved agent commands --json`. Resolve an
individual command and its current availability with
`paved agent command <name> --json`. The result includes its input/output
shape, required context, side effects, lifecycle states, workflow or tool
mapping, and actionable unavailability reason. Discovery is read-only; native
commands invoke the packaged runtime through a project-local bootstrap launcher.

| Command | Purpose and input | Lifecycle / relevant context | Side effects and output | Failure behavior |
|---|---|---|---|---|
| `init` | Bootstrap and initialize Paved; no input | `UNINITIALIZED`; repository evidence | Acquires a pinned runtime, initializes `.paved/`, and generates context | Never resets existing state; malformed or unverified runtime state fails. |
| `status` | Inspect Paved state; no input | Any lifecycle; manifest and lock | Read-only machine-readable state and diagnostics | Reports missing/invalid state without writes. |
| `plan` | Plan a requested change and acceptance constraints | `RESOLVED`, `GENERATED`, `VALIDATED`, or `READY`; project context, rules, workflow and verification profile | Agent response: affected areas, constraints, tasks, risks, verification and unknowns | Missing workflow/context blocks; existing patterns are not automatically architecture. |
| `implement` | Execute an approved plan or reference | Same development states; project context, rules, workflow, skills and tool bindings | Planned application edits and disposable evidence; returns changes and gaps | Missing approval/context/tool blocks; human-owned state is protected. |
| `test` | Optional JSON inputs declared by the testing Tool (`paved test --inputs '<json>'`) | Same development states; exactly one testing Tool and valid ToolImplementation | Bounded process execution and sanitized, incomplete testing evidence; does not run Paved verification | A missing/ambiguous Tool, invalid binding, unsafe path, malformed output, timeout or nonzero exit fails explicitly. Application scripts are never inferred or run. |
| `verify` | Run the configured profile; no arbitrary check selectors | Same development states; verification profile and approved Tool bindings | Uses the existing verification engine; may write disposable evidence | Missing profile, unresolved tools or failed checks block. |
| `review` | Optional change scope | Same development states; project context, rules, verification profile and review skill | Agent response with findings, risks, evidence gaps and unknowns | Missing evidence is a gap, not a pass; review never replaces verification. |
| `debug` | Failure report, expected behavior and reproduction evidence | Same development states; feature map, bug workflow and debugging skills | Read-only investigation: observations, hypotheses, unknowns and next step | Hypotheses remain unconfirmed until observed; missing evidence is explicit. |
| `refactor` | Structural goal and code scope | Same development states; architecture, rules and refactor workflow | Planned edits and non-regression evidence | Unpinned behavior or unmet human approval gates block changes. |
| `feature` | Feature request and acceptance criteria | Same development states; project context, rules, feature workflow and verification profile | Composes understand, plan, implement, test, verify and review | Stops at unmet approval gates or missing required tools/context. |
| `fix` | Observed failure and expected behavior | Same development states; project context, rules, bug workflow and verification profile | Composes reproduction, diagnosis, fix, regression test, verification and review | A fix without confirmed cause or regression evidence is incomplete. |
| `update` | Update local Core/adapters/inputs; no input | Initialized lifecycle; manifest and lock | Uses the existing safe update transaction | Unknown compatibility, migrations and ownership conflicts stop unsafe writes; remote update is unsupported. |
| `doctor` | Diagnose state; no input | Any lifecycle; manifest, lock and verification profile | Read-only actionable diagnostics | Reports issues without automatic repair. |
| `gardener` | Analyze evidence; no input | `RESOLVED`, `GENERATED`, `VALIDATED`, or `READY`; generated evidence and review state | Read-only observations/proposals | Missing evidence remains a finding; humans approve improvements. |

Development commands persist `WorkflowRun` state under
`.paved/generated/runs/`. `feature`, `fix` and `refactor` advance the existing
Core workflow phases. `plan`, `debug`, `implement` and `review` use the same
runs. The agent supplies observations and code changes; the runtime checks
phase order and plan approval, calls the testing Tool during validation, runs
authoritative Paved verification, and requires matching workflow evidence
before completion.

The CLI `test` operation invokes an explicitly declared testing Tool using the
existing Tool contracts, ToolImplementation resolver and bounded process
runner. It records sanitized evidence as incomplete/unverified; `verify`
continues to execute only checks configured in the project verification
profile. The Codex and Claude projections call the same `test` handler through
the integrity-checking launcher.

## Distribution status

Paved is distributed as a native Codex and Claude Code plugin through
GitHub-backed marketplace distribution from this repository; see
[Installing the Paved plugin](../getting-started/installing-the-plugin.md). The
plugin bundles the `paved-core` runtime tarball, so activation needs no registry.
`paved-core` is not published to npm and the plugin is not listed in a public
plugin directory; the launcher's registry path applies only to a lock that pins a
runtime the plugin does not bundle.
