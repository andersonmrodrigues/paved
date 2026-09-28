# Conversational Decision Resolution Across the Paved Lifecycle

- **Status:** Approved design, not yet implemented
- **Date:** 2026-09-28
- **Scope:** Phase 25 (all 27 sub-phases), single spec by explicit request

## Problem

Paved can already infer deterministic capability providers from repository evidence
(Phase 24). It cannot *ask*. When repository evidence admits more than one valid answer,
Paved stops and tells the user to edit a YAML file. That makes `.paved/` the primary
human configuration interface, which is backwards: the agent should be the interface,
and `.paved/` should be the materialized state of decisions made through it.

This design introduces one canonical decision protocol, reused by every Paved command,
so that Paved resolves what it can prove, asks the user only what genuinely belongs to
them, applies the answer itself, persists it with provenance, and continues.

    USER  ↕  AI CODING AGENT  ↕  PAVED

## Goals

- Users never edit `.paved/` during normal usage.
- One decision protocol, one persistence model, one result contract, across all commands.
- Deterministic decisions resolve silently with evidence; material decisions are asked.
- Answers survive interruption, restart and resume; stale answers are invalidated.
- The existing approval security model is preserved, not weakened.

## Non-goals

- A second workflow engine, lifecycle, approval system or persistence model.
- Interactive TTY prompting inside the CLI.
- Making unsafe conditions answerable.

---

## 1. Decision classification policy

Every decision Paved encounters is classified into exactly one of three categories.
Only one of them produces a question.

| Category | Condition | Behaviour |
|---|---|---|
| `deterministic` | Sufficient evidence, one safe interpretation | Decide automatically, record evidence and provenance in **existing** stores, continue. No question, no new file. |
| `material` | Multiple valid alternatives; the choice belongs to the project | Raise a `Decision`, return `awaiting_input`, wait, validate, persist, apply, continue. |
| `unsafe` | Not enough information to continue safely | **Blocking diagnostic. Never a question.** |

### Resolution of a spec tension: `unsafe` is not a decision record

Phase 2 lists UNSAFE as a decision category, but Phase 22 forbids offering unsafe
conditions as questions, and states the correct behaviour is
*"This capability is unavailable because no approved ToolImplementation exists"* — which
is Paved's existing blocking-diagnostic mechanism.

Therefore the three-way classification is the **policy the decision gate applies**, but:

- `material` → an askable `Decision` record, persisted as a `Decision` document (§3).
- `deterministic` → **projected** as a `Decision`-shaped object in `CommandResult.decisions`
  with `status: APPLIED` and `answer_source: derived`, so agents see one uniform shape —
  but **never persisted as a `Decision` document**. Its durable form is the store it
  already has: a `paved.lock` `capabilities[]` entry with `source: inferred` and evidence.
  Projection is for uniformity; persistence is for authority, and they are deliberately
  different here.
- `unsafe` → a `Diagnostic`. No record, no projection. Recording it as a decision would
  make it look answerable.

---

## 2. The `Decision` record

New schema: `schemas/decision.schema.yaml`.

### Naming convention

The persisted YAML is **snake_case**, matching every other Paved document
(`decided_by`, `first_observed`, `evidence_sha256`). The `CommandResult` projection is
**camelCase**, matching every other result payload (`lifecycleState`, `nextAction`).
This mirrors the split `statusData()` already performs. The Phase 25 brief used
camelCase for the record; that is reinterpreted as the projection shape.

### Fields

| Field | Type | Notes |
|---|---|---|
| `apiVersion` | `paved/v1` | |
| `kind` | `Decision` | |
| `id` | string | `d-<sha256(question ‖ scope ‖ candidates)[0:20]>`. Content-derived and stable, so re-raising the same question resolves to the same record. Validated against `^d-[a-f0-9]{20}$` before any path construction. |
| `scope` | `project` \| `run` | Selects the store (§3) |
| `command` | string | Originating command |
| `run` | string? | Present iff `scope: run` |
| `category` | `deterministic` \| `material` | `unsafe` never reaches a record |
| `authored_by` | `runtime` \| `agent` | §4 |
| `question` | string | |
| `reason` | string | Why the decision matters. Required, non-empty. |
| `options[]` | object | `{ id, label, description, consequence }` |
| `recommended_option` | string? | **Requires at least one `evidence` entry when present.** |
| `evidence[]` | object | `{ type, location, sha256 }` — same shape as `provenance.sources` |
| `required` | boolean | Whether the originating command can proceed without an answer. `true` → an `ASKED` instance drives `awaiting_input`. `false` → surfaced alongside a normal result without blocking (used by `doctor` and `gardener`). |
| `required_answer` | object | Validation contract (§2.3) |
| `risk` | `low` \| `medium` \| `high` | Projection of the apply handler's effect class (§6) |
| `reversibility` | `reversible` \| `recoverable` \| `irreversible` | Projection of the apply handler's effect class (§6) |
| `answer_channel` | `relayed` \| `human-authored` | Derived, never supplied (§6) |
| `depends_on[]` | string[] | Unresolved dependencies hold the decision at `PENDING` |
| `status` | enum | §2.2 |
| `answer` | any? | Shape governed by `required_answer` |
| `answered_by` | string? | Non-empty; rejected if in `{agent, paved, ci}` |
| `answer_source` | `derived` \| `agent-relayed` \| `human-authored` | |
| `answered_at` | date-time? | |
| `applied_changes[]` | string[] | Repository-relative paths Paved wrote |
| `applied_at` | date-time? | |
| `fingerprint` | object | `{ inputs[], sha256 }` — invalidation key (§2.4) |
| `supersedes` | string? | |
| `superseded_by` | string? | |
| `superseded_reason` | string? | |
| `created_at` | date-time | |

### 2.2 State machine

```
PENDING ──emitted──▶ ASKED ──valid answer──▶ ANSWERED ──materialized──▶ APPLIED
   │                   │
   │                   └──user declines──▶ REJECTED
   │
   ├──run cancelled / withdrawn──▶ CANCELLED     (from PENDING, ASKED)
   └──fingerprint mismatch──▶ SUPERSEDED         (from PENDING, ASKED, ANSWERED, APPLIED)
```

- `PENDING` — raised but not surfaced (dependencies unsatisfied). Never emitted.
- `ASKED` — surfaced in an `awaiting_input` result.
- `ANSWERED` — a valid answer is recorded, not yet materialized.
- `APPLIED` — terminal. Effect materialized; `applied_changes` recorded.
- `REJECTED` — terminal. **The user declined the proposal** (e.g. answering "None" to a
  verification-gate proposal). Persisted so Paved does not re-ask. An *invalid* answer is
  not this state: it returns a `usage` diagnostic and the decision stays `ASKED`.
- `CANCELLED` — terminal. The run was cancelled or the decision withdrawn.
- `SUPERSEDED` — terminal. Evidence changed; a successor carries `supersedes`.

### Crash safety

`ANSWERED` is persisted **before** the configuration mutation; `APPLIED` **after**. A
crash between them leaves `ANSWERED`, and the next invocation re-applies.

> **Hard requirement:** every apply handler must be idempotent.

### 2.3 Answer validation contract

`required_answer.type` ∈ `single-choice` | `multi-choice` | `boolean` | `free-text`.

- `single-choice` — one `options[].id`.
- `multi-choice` — a subset of `options[].id`. Submitted by **repeating** `--answer`,
  never comma-splitting (commas are legal inside free text).
- `boolean` — `true` / `false`.
- `free-text` — constrained by `pattern` and `maxLength` in the record.

> **Invariant:** a `free-text` answer is **data only**. It may be written into a
> schema-validated configuration field and nowhere else. It can never become an
> executable argument, a path, or a command fragment.

An invalid answer produces a `usage` diagnostic; the decision remains `ASKED`.

### 2.4 Invalidation — the narrowness rule

> `fingerprint` digests **only the decision's own `evidence` refs plus its candidate
> set** — never the whole source tree.

This is what makes Phase 17 and Phase 23 compatible. A broad fingerprint would supersede
and re-ask every answered question on any unrelated commit.

Recomputed on every decision-gate run, for **all** states including `APPLIED`, so a
topology change that removes a chosen provider supersedes the applied decision and raises
a successor. Triggers: repository topology change, selected-module change, runtime
compatibility change, material plan change (`plan_sha256`), evidence change, and explicit
`paved decision revise`.

---

## 3. Persistence and ownership

Three stores, because the spec requires reusing existing persistence rather than adding one.

| Kind | Store | Rationale |
|---|---|---|
| `deterministic` | **Existing mechanisms only** — `paved.lock` `capabilities[]` with `source: inferred` and evidence (`capabilityLockEntries`, `cli/lib/adapters.ts:241`), plus generated-artifact provenance. Projected into results, never written as a `Decision` document (§1). | Phase 24 already persists these with evidence. New files would duplicate an existing store and bury material decisions in noise. |
| `material`, run-scoped | `decisions[]` inside the `WorkflowRun` at `.paved/generated/runs/<id>.yaml` | The brief's explicit instruction. The question only has meaning inside its run. |
| `material`, project-scoped | `.paved/decisions/<id>.yaml` | `init`, `verify`, `doctor`, `gardener`, `update` have no run. |

**Run-scoped decisions inherit the run's `disposable`, uncommitted ownership.** Deleting
`.paved/generated/` deletes the run, and a question belonging to a deleted run should die
with it. "Do not lose an unanswered question" is scoped to the lifetime of the thing that
asked it.

**Project-scoped decisions are `tool-managed`, `committed: true`.** These answers are the
standing authority for configuration Paved wrote. Uncommitted, a teammate cloning the
repository would find a verification profile with no record of who approved it or on what
evidence.

### 3.1 `consumer_layout` additions (`manifest.yaml`)

```yaml
- path: .paved/decisions/
  ownership: tool-managed
  required: false
  committed: true
  schema: Decision
  description: >
    Material project-scoped decisions Paved asked and the project answered, with their
    evidence, answer provenance and the state each answer produced. Written only by Paved
    commands; the authority for configuration Paved wrote on the project's behalf.

- path: .paved/approvals/
  ownership: human-owned
  required: false
  committed: true
  description: >
    Human-authored approval records for irreversible decisions and plan approval
    (<run-id>.json, <decision-id>.json), bound to the exact content approved.
```

The second entry **closes a pre-existing gap**: the workflow runtime has read and written
`.paved/approvals/` since `cli/commands/workflow.ts:175` without the layout declaring its
ownership. Phase 18's guarantee depends on that path being human-owned by contract.

### 3.2 `WorkflowRun` schema changes

- `status` enum gains `awaiting-input`.
- New `decisions[]` array of `Decision` records.
- New event types: `decision-raised`, `decision-asked`, `decision-answered`,
  `decision-applied`, `decision-superseded`.
- New cross-field rules in `assessRun()` (`cli/lib/workflows.ts:229`), mirroring the
  existing *"run is awaiting approval but no gate is"* check at line 296:
  - a run may be `awaiting-input` only if at least one decision is `ASKED`;
  - a run may not be `running` while a required decision is unanswered.

Most current uses of the `input-missing` failure code (`cli/lib/workflows.ts:72`), which
drives a run to `blocked / requires-human`, become `awaiting-input` decisions. The code
remains in the enum for genuinely unanswerable cases.

### 3.3 Mechanics

- **No index file.** `status` scans `.paved/decisions/` plus run records. An index would
  be a second source of truth that can drift.
- **Path safety.** The `^d-[a-f0-9]{20}$` id guard runs before path construction (mirroring
  `runPath()` at `cli/commands/workflow.ts:62`), combined with `resolveSafePath`.
- **Atomicity.** Records written with `atomicWriteFileSync`.
- **Concurrency.** The whole answer→apply transaction holds
  `acquireConsumerOperationLock` (`cli/lib/operation-lock.ts`).
- **Validation.** `Decision` joins the directory list in `validateConsumerDocuments`
  (`cli/lib/consumer-state.ts:761`).

### 3.4 Backward compatibility (Phase 24)

An absent `.paved/decisions/` means no decisions; existing repositories need no migration.

> **Paved does not synthesise decision records retroactively.** Valid existing
> configuration (a hand-written `profile.yaml`, an explicit `manifest.capability_providers`)
> is read as *already decided*, and no question is raised — but no record is fabricated.

Inventing one would mean writing `answered_by` for a human who never answered, which is
exactly the "never represent inferred as human approved" line in Phase 21. Absence of a
record plus presence of valid configuration is the honest representation.

---

## 4. Question authorship

Paved's runtime is deterministic TypeScript. It can derive "two capability providers are
ambiguous" from repository evidence; it cannot derive "which identity provider?" from the
free text "Add SSO" (Phase 3), or "preserve the response shape or version it?" from a diff
(Phase 7). Both authorship sources therefore exist, governed identically.

| `authored_by` | Source | Examples |
|---|---|---|
| `runtime` | Derived from repository evidence | Ambiguous capability provider; no verification profile with detected candidates; ambiguous testing scope; doctor repair; gardener proposal adoption |
| `agent` | Declared through `paved decision raise` | "Which identity provider?"; "Preserve the response shape or version it?" |

Same schema, same store, same invalidation, same audit. The runtime validates and governs
both. Agent-raised decisions are rejected if they set `authored_by: runtime`, set
`category: deterministic`, carry an empty `reason` or empty `evidence`, or reference an
apply handler outside the registered catalogue.

> **Corollary (§3, §7):** runtime-authored decisions are *recomputable* from evidence
> because ids are content-derived and providers are idempotent. The store is therefore a
> **cache** for them, which lets read-only commands ask without writing. Agent-authored
> decisions cannot be recomputed and are always persisted on raise.

---

## 5. Result contract and CLI surface

### 5.1 `awaiting_input`

`ResultStatus` gains `awaiting_input`. `EXIT_CODES` gains `"awaiting-input": 10`.

Two invariants:

- *(existing)* `status: "failed"` requires at least one blocking diagnostic, else
  `createResult` injects `PAVED_RESULT_MALFORMED_FAILURE` (`cli/result.ts:81`).
- *(new)* **`status: "awaiting_input"` requires at least one `ASKED` decision with
  `required: true`, and zero blocking diagnostics.** A command with both a real blocker and
  a pending question is `failed` — Paved must not ask a question it cannot act on
  regardless of the answer.

Optional decisions (`required: false`) are emitted in `decisions[]` alongside a `success`
or `warning` result and never block. This is what keeps `doctor` and `gardener` advisory:
they surface proposals without holding the command hostage to an answer.

`primaryCategory()` short-circuits on `awaiting_input` before the diagnostic-escalation
loop; the second invariant guarantees there is nothing to escalate.

**Known naming asymmetry, accepted deliberately.** The brief pins
`status: "awaiting_input"` (underscore) as the machine contract, and it is followed
literally. `WorkflowRun.status` uses kebab-case like its neighbour `awaiting-approval`, so
the run status is `awaiting-input`. These are different enums on different objects.

### 5.2 `decisions` is protocol, not payload

```ts
export interface CommandResult<TData = unknown> {
  readonly command: string;
  readonly status: ResultStatus;
  readonly data?: TData;
  readonly decisions?: readonly DecisionProjection[];   // new
  readonly diagnostics: readonly Diagnostic[];
}
```

Top-level, parallel to `diagnostics`, rather than inside `data`: every command's `data`
shape differs, so an agent would need per-command knowledge to find pending questions. A
top-level field is uniformly addressable and lets `renderJson`/`renderHuman` handle
decisions **once, centrally**.

`CommandResult.command` keeps its existing bare-name form (`"feature"`, from
`invocation.command`). The brief's sketch showed `"paved.feature"`; changing it would
break every existing consumer and test for a cosmetic gain. `runId` is exposed on the
projection instead.

`DecisionProjection` = `{ id, question, reason, options[], recommended, evidence[],
required, risk, reversibility, answerChannel, dependsOn[], runId? }`.

### 5.3 Flags

| Flag | Applies to | Notes |
|---|---|---|
| `--answer <id>=<value>` | all commands | Repeatable. `multi-choice` repeats the flag. |
| `--answered-by <identity>` | all commands | **Required whenever `--answer` is present.** Rejected if empty or in `{agent, paved, ci}`. **No fallback to `git config user.email`** — a fallback would hand an agent a plausible human identity for free. |
| `--run <id>` | unchanged | Keeps its current restriction to workflow commands. |

Answers are submitted to the **originating command**, which then applies them and
continues in the same invocation:

```
paved verify --answer d-7f3a=all --answered-by anderson@example.com --json
paved feature --run feature-abc --answer d-91c2=keycloak --answered-by anderson@example.com --json
```

**Replay semantics.** Re-answering an `ANSWERED`/`APPLIED` decision with the *same* value
is an idempotent no-op success (this is what makes crash recovery safe to retry).
Re-answering with a *different* value is a `usage` error directing the caller to
`paved decision revise`, so an applied decision is never silently overwritten.

### 5.4 The `decision` command

Added to `COMMAND_NAMES` / `COMMAND_RULES`:

```
paved decision raise --decision <json>        # agent-authored; validated against the schema
paved decision list [--run <id>]
paved decision show <id>
paved decision revise <id> --reason <text>    # → SUPERSEDED + successor
```

`raise` takes a single JSON object rather than a dozen flags, validated on the way in —
following the `--inputs <json>` precedent for `test` (`cli/runtime.ts:282`).

### 5.5 No TTY prompting

`paved feature "…"` renders pending decisions as readable text and exits with code 10.
The human or agent re-invokes with `--answer`. The CLI stays a pure non-interactive
dispatcher, and there is exactly **one** interaction mechanism for agents, humans and CI.
"Interactive mode" means human-readable rendering, not stdin.

`renderHuman` (`cli/output.ts`) gains one central decisions block: id, question, reason,
numbered options, recommendation with evidence, and the exact resume command. Centralised,
so no handler can render questions inconsistently.

---

## 6. Security

### 6.1 The answer channel is derived from effects, not claims

> **The answer channel is derived from the registered effect class of the decision's apply
> handler — never from a field the caller supplies.**

Every apply handler is registered in the catalogue with its effect class. `risk` and
`reversibility` on the record are a *projection* of that registration:

```
human-authored   if effect class is irreversible, or the decision is a plan approval
relayed          otherwise
```

An agent-raised decision may only reference a registered apply handler, or none at all (a
pure requirement answer landing in the run record — trivially reversible). An agent may
raise a decision's risk but never lower it. The tiering is tamper-proof by construction.

### 6.2 The human-authored channel

`.paved/approvals/<decision-id>.json`:

```json
{
  "decision": "d-7f3a…",
  "decision_sha256": "<digest of the exact question, options and evidence>",
  "answer": "…",
  "decided_by": "anderson@example.com",
  "decided_at": "2026-09-28T14:02:11.000Z"
}
```

Validation reuses the shape of `cli/commands/workflow.ts:174-184`: id must match, digest
must match, `decided_at` must parse, `decided_by` must be non-empty and outside
`{agent, paved, ci}`. Binding to `decision_sha256` gives the same anti-stale property the
plan approval already has.

### 6.3 Phase 18 rejections

| Attack | Mechanism |
|---|---|
| Self-approval | `answered_by` / `decided_by` blocklist, on both channels |
| Wrong-plan approval | `plan_sha256` binding — existing behaviour, preserved unchanged |
| Wrong-decision approval | `decision_sha256` binding |
| Forged approval | Approval file for a decision not in `ASKED` → rejected |
| Stale approval | Supersession changes the content digest → approval no longer matches |

### 6.4 Phase 22 — hard invariants no answer can override

**Unsafe conditions are filtered before a decision is raised, not after it is answered.**
A candidate whose apply handler would cross a hard invariant is never turned into a
question; it becomes a blocking diagnostic.

- No apply handler may construct an executable command from an answer.
- **Answering selects among authorised implementations; it never authorises one.** A
  `ToolImplementation` must already be `available` and pass `authorizeTool`
  (`cli/lib/test-runner.ts:349`) to appear as an option.
- No decision may alter lock digests or runtime selection, or suppress
  `PAVED_LOCK_*_MISMATCH` / `PAVED_RUNTIME_*`. Integrity failures remain failures.
- All writes go through `resolveSafePath` plus the decision-id guard.
- `evidence[]` and `options[]` apply the existing secret-rejection filter
  `/secret|token|password|credential|private|api.?key/i` (`cli/lib/adapters.ts:205`);
  free text echoed into records goes through `sanitizeToolOutput`.

### 6.5 Phase 21 — provenance via existing vocabulary

Paved already distinguishes `observed | documented | enforced | inferred | unknown`
(`cli/lib/gardener.ts:8`). The decision record is the artifact that carries a subject
across those states:

```
evidence cited      → observed     (what the repository does)
answer recorded     → documented   (what the project says it wants)
answer materialised → enforced     (what Paved now checks)
```

A recommendation may cite `observed` evidence, but only an answer yields `documented`,
and only materialisation yields `enforced`. Combined with the rule that
`recommended_option` requires at least one evidence entry, both directions are guarded.

---

## 7. The shared decision gate

`cli/lib/decisions.ts` exposes one pipeline, called by every command before it works:

```
1. LOAD        existing decisions (project store + run record)
2. REVALIDATE  re-fingerprint → mismatches become SUPERSEDED, successors raised
3. ANSWER      apply --answer flags → validate → ANSWERED (persist)
4. MATERIALIZE ANSWERED → apply handler → APPLIED (persist; idempotent; under lock)
5. DETECT      run the command's decision providers
                 deterministic → auto-apply via existing lock/provenance
                 material      → raise
6. SEQUENCE    emit only decisions whose depends_on are satisfied
7. VERDICT     any ASKED with required:true → awaiting_input
               otherwise continue, emitting optional decisions alongside the result
```

Commands register **decision providers** (`(context) => DecisionCandidate[]`) and **apply
handlers** (`(answer, context) => appliedChanges[]`). Handlers stay thin and each decision
type is unit-testable without running its command. Providers must be idempotent: the same
evidence yields the same decision id, so re-running a command never duplicates a question.

### 7.1 Paved never writes human-owned files

Several decisions would naturally write their answer into `.paved/manifest.yaml`, which is
`ownership: human-owned` (`manifest.yaml:131`). Writing there would break the ownership
model Paved enforces on everyone else.

| Target | Ownership | How the answer lands |
|---|---|---|
| `.paved/verification/profile.yaml`, `.paved/rules/`, `.paved/tools/`, `.paved/tool-implementations/` | `project-owned` | Paved writes the file directly |
| `.paved/paved.lock` | `tool-managed` | Paved writes |
| `.paved/manifest.yaml` (`capability_providers`) | `human-owned` | **Never written.** The answer stays in the decision record and `resolveCapability` consults it |
| `.paved/gardener/reviews.yaml` | `human-owned` | **Never written.** Adoption materialises the rule into `.paved/rules/` and records the decision |
| `AGENTS.md` | `human-owned` | Existing delimited-block mechanism only |

`resolveCapability`'s precedence (`cli/lib/adapters.ts:137`) becomes:

```
explicit manifest override
  → explicit scoped manifest
  → answered decision        (new)
  → deterministic inference
  → ambiguous
```

The human-owned manifest still wins everything.

### 7.2 Per-command catalogue

| Command | Decisions raised | Author | Answer materialises |
|---|---|---|---|
| `init` | Verification gates from detected build/CI commands; detected rule conventions; ambiguous capability provider | runtime | `profile.yaml`, `.paved/rules/`, decision record |
| `status` | **None — read-only.** Reports `pendingDecisions`, `pendingApprovals`, `verificationReadiness`, `unavailableCommands`, `nextAction` | — | — |
| `plan` | Missing requirements (identity provider, affected applications, acceptance behaviour) | agent | Plan evidence cites the decision ids that shaped it |
| `implement` | Which valid `ToolImplementation`; module scope; compatibility stance; regenerate-or-keep generated code | runtime + agent | Binding, run record |
| `test` | Ambiguous testing scope or provider | runtime | `.paved/tool-implementations/` binding, or resolver input |
| `verify` | Adopt detected checks as gates | runtime | `.paved/verification/profile.yaml` |
| `review` | Unresolved product/architecture choices | agent | Run record |
| `feature` / `fix` / `refactor` | All of the above, run-scoped across phases | both | Run record and the above |
| `update` | Adopt provider change; apply migration | runtime | Lock, via the existing update transaction |
| `doctor` | Proposed repairs (what, why, risk, files) — `required: false`, **not persisted until answered** | runtime | The repair itself |
| `gardener` | Adopt proposals as rules — `required: false` | runtime | `.paved/rules/` |

### 7.3 Command-specific invariants

- **`verify`: choosing checks is not passing them.** The answer writes the profile;
  verification then *executes*. No answer on any path may produce verified evidence.
- **`test` / `implement`: ambiguity is askable, absence is not.** `resolveTestingTool`
  currently fails with `PAVED_TEST_TOOL_AMBIGUOUS` when `tools.length !== 1`
  (`cli/lib/test-runner.ts:162`). That splits: **> 1 → material decision**; **0 →
  unchanged blocking diagnostic**.
- **`doctor` stays read-only by default.** Because runtime-authored decisions are
  recomputable (§4), doctor renders repair candidates without persisting anything, and
  persists only when an answer arrives.
- **`gardener` proposals are never enforced automatically.** Adoption requires an answer.

### 7.4 Command availability

`availability()` (`cli/lib/agent-commands.ts:84`) currently marks `feature`, `fix`,
`refactor` and `implement` unavailable when no verification profile exists. That becomes:

- missing profile **with** detectable candidates → *available, will ask*;
- missing profile **without** candidates → unavailable, as today.

### 7.5 `init`'s end state — no new lifecycle state

`init` returns `status: awaiting_input` with `lifecycleState: GENERATED` (already a
legitimate, non-error state meaning "generated, profile not yet present") plus the
decisions. The setup-pending condition lives in the **result contract**, uniform across all
commands, rather than in the lifecycle enum — which would otherwise ripple through
`ConsumerLifecycleState`, `AgentCommandLifecycleState` and every availability table for no
added information.

Phase 2's "Waiting for 2 decisions" is a `status` field, not a lifecycle state. A material
unanswered proposal is **never** reported as an initialization error.

---

## 8. Agent integrations

Both hosts already render from one function, `renderCommand()`
(`integrations/shared/projection.ts:51`), differing only in title format, frontmatter and
launcher path. Phase 14's "do not duplicate decision logic" is satisfied **by
construction**, provided the conversational contract lives in the shared renderer.

1. **`AgentCommandContract` gains declarative interaction fields**, exposed through
   `paved agent commands --json`:

   ```ts
   interaction: "conversational" | "read-only";
   decisionSources: readonly ("runtime" | "agent")[];
   answerChannels: readonly ("relayed" | "human-authored")[];
   ```

2. **A new canonical `decisions` skill** in `core/skills/`, projected to both hosts,
   holding the interaction protocol exactly once: how to present a decision (detected →
   remaining → why it matters → options → recommendation → evidence → what happens next),
   and the prohibitions — never answer a material decision on the user's behalf, never
   fabricate `--answered-by`, never invent an option Paved did not offer, never use
   `decision raise` to route around a runtime-authored decision.

   This factoring is **required to pass existing tests**: `assessWorkflowQuality` runs
   `duplicatedSentences` across workflow and skill bodies (`cli/lib/workflows.ts:201`), so
   inlining the same prose into fourteen command documents would trip it.

3. **`renderCommand()` emits a short per-command conversational contract** — invoke →
   receive `awaiting_input` → present → collect → resume with `--answer`/`--answered-by` →
   present result — referencing the skill rather than restating it.

`plugins/build.ts` regenerates `plugins/paved/skills/`; `npm run check:plugin` proves no
drift.

### 8.1 Question batching UX

All decisions whose dependencies are satisfied are emitted **together** in one
`awaiting_input`. Dependent decisions are sequenced by `depends_on` and are not emitted
until their dependencies resolve. Internal implementation detail is not exposed; the agent
presents only the current decisions or required action.

---

## 9. Documentation

| Document | Change |
|---|---|
| `docs/concepts/decisions.md` | **New.** Categories, state machine, invalidation, persistence, channels, resume, batching. |
| `docs/decisions/0028-conversational-decision-resolution.md` | **New ADR**, next in sequence after 0027. |
| `docs/getting-started/integrating-a-repository.md` | **Rewrite.** Replaces the current instruction at line 51 to *"Copy `core/templates/verification-profile.yaml` to `.paved/verification/profile.yaml`"* with the `init → answer → done` conversation. |
| `docs/concepts/workflow-approval.md` | Risk-tiered channel; what each channel does and does not prove. |
| `docs/concepts/workflow-state.md` | `awaiting-input` run status, `decisions[]`, new event types. |
| `docs/concepts/tool-results.md` | `awaiting_input`, exit code 10, top-level `decisions`. |
| `docs/concepts/ownership-and-regeneration.md` | `.paved/decisions/`, `.paved/approvals/`, and §7.1. |
| `docs/concepts/agent-integration.md`, `agent-commands.md` | The conversational loop and the `decisions` skill. |
| `docs/concepts/verification.md` | Profile adoption by decision; choosing ≠ passing. |
| `README.md` | The `User ↕ Agent ↕ Paved` principle. |

**Placement rule for manual configuration.** Phase 24 requires hand-configured
repositories to keep working, so direct file configuration must stay *documented* — but it
moves to a clearly-labelled "Direct configuration" subsection presented as the advanced
route. The conversational flow is the getting-started path. Deleting the manual
documentation outright would leave supported users with none.

---

## 10. Test matrix

### 10.1 New suites

| Suite | Covers |
|---|---|
| `tests/decisions/record.test.ts` | Schema, state machine, legal and illegal transitions |
| `tests/decisions/invalidation.test.ts` | Fingerprint narrowness, supersession, stale reuse, explicit revise |
| `tests/decisions/answers.test.ts` | Validation per `required_answer` type, invalid answer keeps `ASKED`, replay idempotence, different-value rejection |
| `tests/decisions/persistence.test.ts` | Interruption, resume, agent restart, crash between `ANSWERED` and `APPLIED` |
| `tests/decisions/batching.test.ts` | Independent decisions batched; dependent decisions sequenced |
| `tests/decisions/security.test.ts` | Self-approval, wrong-plan, wrong-decision, forged, stale; hard invariants not overridable; free text never argv; path traversal; secret filter |
| `tests/cli/decisions.test.ts` | `awaiting_input` JSON shape, exit code 10, `--answer` / `--answered-by`, continuation, `decision` subcommands |
| `tests/acceptance/no-manual-configuration.test.ts` | Phase 19 (below) |

### 10.2 Extended suites

- `tests/agent-contract/synthetic-agent.test.ts` — its `Result` type hardcodes
  `"success" | "warning" | "failed"` at line 17 and must learn `awaiting_input`; add the
  conversational path for both hosts.
- `tests/integrations/projection.test.ts` — host parity for the conversational contract.
- `tests/adapters/runtime-stacks.test.ts`, `tests/plugins/stacks.test.ts` — decision-path
  coverage per stack.
- `tests/cli/lifecycle.test.ts`, `tests/workflows/execution.test.ts` — `awaiting-input` run
  status and decision events.

### 10.3 Phase 19 — the clean-room acceptance test

`tests/acceptance/no-manual-configuration.test.ts` must be **self-enforcing**, not merely
well-behaved. Every harness filesystem write is routed through a guard that **throws** on:

```
.paved/manifest.yaml
.paved/paved.lock
.paved/verification/profile.yaml
.paved/tools/*
.paved/rules/*
```

The test then drives clean repository → plugin installation → `init` → detection →
question → answer → Paved writes configuration → `plan` → requirement decision → approval
→ `implement` → `test` → `verify` → `review` → completion, and repeats equivalent paths for
`feature`, `fix`, `refactor`, `update` and `gardener`.

If any flow requires manual editing, the test fails **by construction** rather than by an
assertion someone might forget to write.

### 10.4 Stacks

Java + Quarkus, TypeScript + Angular, Dart, Dart + Flutter, PostgreSQL, Git-only, and an
Apecatus-shaped fixture.

### 10.5 Two honest limits

- **Phase 20 (Apecatus) is not an automated test.** It is a real external repository that
  CI cannot clone. Coverage is (a) a fixture in `tests/fixtures/` mirroring its shape —
  Java/Quarkus backend, TypeScript/Angular frontend, Checkstyle, `mvn` and `npm` scripts —
  and (b) a documented manual validation run against the real repository. Calling the
  fixture "Apecatus validation" would overstate it.
- **Phase 23's "minimum number of questions" is not deterministically testable** for
  agent-authored questions; no runtime check distinguishes a valuable question from a lazy
  one. The partial brake is that every agent-raised decision must carry a non-empty
  `reason` and non-empty `evidence`. Beyond that it is skill guidance, and is documented as
  guidance rather than presented as an invariant.

---

## 11. Acceptance traceability (Phase 27)

| Criterion | Proven by |
|---|---|
| No manual editing during normal usage | §10.3 |
| `init` resolves deterministic decisions | §1, §3 (lock reuse); `tests/decisions/record.test.ts` |
| `init` asks for material decisions | §7.2; `tests/cli/decisions.test.ts` |
| `init` applies answers automatically | §7.1; §10.3 |
| `plan` asks for unresolved requirements | §4, §7.2 |
| `implement` asks for missing material decisions | §7.2 |
| `test` asks for ambiguous scope | §7.3 |
| `verify` asks for verification policy | §7.2, §7.3 |
| `review` asks for product/architecture decisions | §7.2 |
| `feature` / `fix` / `refactor` conversational | §7.2; §10.3 |
| `update` handles migration decisions | §7.2 |
| `doctor` asks before non-read-only repair | §7.3 |
| `gardener` presents proposals conversationally | §7.2, §7.3 |
| One canonical protocol across commands | §7 |
| Codex and Claude equivalent | §8; `tests/integrations/projection.test.ts` |
| CLI equivalent | §5 |
| Decisions persist across interruption | §2.2, §3; `tests/decisions/persistence.test.ts` |
| Decisions resumable | §5.3 |
| Stale decisions invalidated safely | §2.4; `tests/decisions/invalidation.test.ts` |
| Agent self-approval rejected | §6.3; `tests/decisions/security.test.ts` |
| Answers cannot bypass security invariants | §6.4; `tests/decisions/security.test.ts` |
| Automatic decisions carry provenance | §1, §6.5 |
| Human decisions auditable | §2, §3, §6.5 |
| Apecatus setup without manual YAML | §10.4, §10.5 (fixture automated; real repository manual) |
| Apecatus reaches healthy lifecycle | §10.5 (manual) |
| Full test suite, typecheck, plugin drift, clean-room | `npm run check`, `npm run check:plugin`, §10.3 |
| Documentation matches behaviour | §9; `tests/core/links.test.ts`, `tests/docs/agent-integration.test.ts` |

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Fingerprint too broad → constant re-asking | §2.4 narrowness rule, tested in `invalidation.test.ts` |
| Apply handlers not idempotent → corruption on crash retry | §2.2 hard requirement; `persistence.test.ts` crash case |
| Relayed channel weakens approval security | §6.1 effect-derived tiering; irreversible work stays file-approved |
| Scope: one spec covering 27 phases | §11 traceability table; spec self-review before planning |
| `awaiting_input` breaks existing consumers | New status is additive; `createResult` invariant prevents malformed results; `synthetic-agent.test.ts` extended |

## 13. Effect class taxonomy

Every apply handler registers exactly one effect class. This is the single input to the
channel derivation in §6.1, and the source of the `risk` / `reversibility` projections.

| Effect class | Writes | `risk` | `reversibility` | Channel |
|---|---|---|---|---|
| `record-only` | Decision or run record only | `low` | `reversible` | relayed |
| `config-additive` | Creates a `project-owned` file that did not exist (`profile.yaml`, a rule, a binding) | `low` | `reversible` | relayed |
| `config-mutating` | Modifies existing `project-owned` configuration | `medium` | `recoverable` | relayed |
| `lock-transaction` | Mutates `paved.lock` through the existing update transaction and its rollback | `medium` | `recoverable` | relayed |
| `repository-mutating` | Writes outside `.paved/` (doctor repairs, generated-code regeneration) | `high` | `irreversible` | **human-authored** |
| `destructive` | Deletes or overwrites non-generated content | `high` | `irreversible` | **human-authored** |

Plan approval is a named special case and is always `human-authored`, independent of
effect class.

A handler's class is declared at registration and is not settable per decision. This is
what makes §6.1 tamper-proof: an agent choosing a handler also chooses its channel, and
cannot select a weaker one.

## 14. Resolved during review

**`update`'s `PAVED_UPDATE_COMPATIBILITY_UNKNOWN` stays a blocking diagnostic.** Its
message — *"No local migration evidence proves Core X can update to Y"* — is by definition
insufficient information to proceed safely, which is `unsafe` under §1, not `material`.
Phase 11 asks for `update` to be conversational about migrations that are *required and
known*; those become decisions. Unknown compatibility is not made answerable, consistent
with §6.4.

**Implementation order.** The `verify` pilot lands first and proves the protocol end to end
— it is the narrowest command, exercises §7.1 file writing, and is the exact Apecatus
scenario — before `init`, the workflow commands, and finally `doctor` / `gardener` /
`update` adopt it. Detailed sequencing belongs to the implementation plan.
