# Agent command reference

Paved defines one agent-neutral command contract and projects it into supported
agent-native command surfaces. Codex exposes generated skills such as
`$paved-feature`; Claude Code exposes `/paved:feature`. Names are presentation
syntax only: both resolve the same stable `paved.<name>` contract.

The contract is discoverable with `paved agent commands --json`. Resolve an
individual command and its current availability with
`paved agent command <name> --json`. The result includes its input/output
shape, required context, side effects, lifecycle states, workflow or tool
mapping, and actionable unavailability reason. These operations describe the
agent work; they do not execute arbitrary prompts or shell commands.

| Command | Purpose and input | Lifecycle / relevant context | Side effects and output | Failure behavior |
|---|---|---|---|---|
| `init` | Initialize Paved; no input | `UNINITIALIZED`; repository evidence | Initializes `.paved/`, materialized context and managed instructions; returns lifecycle and diagnostics | Never resets existing state; malformed partial state fails. Requires an available local Core runtime. |
| `status` | Inspect Paved state; no input | Any lifecycle; manifest and lock | Read-only machine-readable state and diagnostics | Reports missing/invalid state without writes. |
| `plan` | Plan a requested change and acceptance constraints | `RESOLVED`, `GENERATED`, `VALIDATED`, or `READY`; project context, rules, workflow and verification profile | Agent response: affected areas, constraints, tasks, risks, verification and unknowns | Missing workflow/context blocks; existing patterns are not automatically architecture. |
| `implement` | Execute an approved plan or reference | Same development states; project context, rules, workflow, skills and tool bindings | Planned application edits and disposable evidence; returns changes and gaps | Missing approval/context/tool blocks; human-owned state is protected. |
| `test` | Optional target/scope supported by the testing Tool | Same development states; testing Tool and approved ToolImplementation | Structured testing evidence when a supported runner exists | Direct Tool invocation is not implemented, so the command is unavailable; a Tool contract alone does not execute a process. Testing remains distinct from verification. |
| `verify` | Run the configured profile; no arbitrary check selectors | Same development states; verification profile and approved Tool bindings | Uses the existing verification engine; may write disposable evidence | Missing profile, unresolved tools or failed checks block. |
| `review` | Optional change scope | Same development states; project context, rules, verification profile and review skill | Agent response with findings, risks, evidence gaps and unknowns | Missing evidence is a gap, not a pass; review never replaces verification. |
| `debug` | Failure report, expected behavior and reproduction evidence | Same development states; feature map, bug workflow and debugging skills | Read-only investigation: observations, hypotheses, unknowns and next step | Hypotheses remain unconfirmed until observed; missing evidence is explicit. |
| `refactor` | Structural goal and code scope | Same development states; architecture, rules and refactor workflow | Planned edits and non-regression evidence | Unpinned behavior or unmet human approval gates block changes. |
| `feature` | Feature request and acceptance criteria | Same development states; project context, rules, feature workflow and verification profile | Composes understand, plan, implement, test, verify and review | Stops at unmet approval gates or missing required tools/context. |
| `fix` | Observed failure and expected behavior | Same development states; project context, rules, bug workflow and verification profile | Composes reproduction, diagnosis, fix, regression test, verification and review | A fix without confirmed cause or regression evidence is incomplete. |
| `update` | Update local Core/adapters/inputs; no input | Initialized lifecycle; manifest and lock | Uses the existing safe update transaction | Unknown compatibility, migrations and ownership conflicts stop unsafe writes; remote update is unsupported. |
| `doctor` | Diagnose state; no input | Any lifecycle; manifest, lock and verification profile | Read-only actionable diagnostics | Reports issues without automatic repair. |
| `gardener` | Analyze evidence; no input | `RESOLVED`, `GENERATED`, `VALIDATED`, or `READY`; generated evidence and review state | Read-only observations/proposals | Missing evidence remains a finding; humans approve improvements. |

Development commands are agent-orchestrated, not a second workflow engine.
They delegate to existing Core workflows, skills, Tools and verification
contracts. The CLI does not execute development prompts. An agent must stop
when a contract, capability, ToolImplementation, approval, or required runtime
is unavailable.

The current CLI has no direct Tool invocation operation. Accordingly,
`/paved:test` is discoverable but explicitly unavailable rather than treating
repository scripts as approved commands. `verify` continues to execute only
checks configured in the project verification profile.

## Runtime and bootstrap limitation

The current distribution is a local Paved Core checkout. The integration
projection can install command files from that checkout, but it does not bundle
the runtime or install a global `paved` executable. Thus a clean consumer with
only generated command files cannot yet bootstrap itself through `/paved:init`;
the local Core checkout and its runtime must already be accessible. No remote
bootstrap is attempted because this release has no published, integrity-pinned
runtime artifact or supported registry.
