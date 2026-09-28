# Conversational Decision Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Paved conversational — it resolves what repository evidence proves, asks the user only what genuinely belongs to them, applies the answer itself, persists it with provenance, and continues, so users never edit `.paved/` during normal usage.

**Architecture:** One canonical `Decision` record with a seven-state machine, persisted in three stores (existing `paved.lock` for deterministic, the existing `WorkflowRun` for run-scoped, a new `.paved/decisions/` for project-scoped). A single decision gate pipeline in `cli/lib/decisions/` runs before every command's work; commands register decision *providers* and *apply handlers*. A new `awaiting_input` result status plus `--answer`/`--answered-by` flags form the only interaction mechanism, shared by agents, humans and CI.

**Tech Stack:** TypeScript (type-stripped, run directly by Node 22), `node:test` + `node:assert/strict`, `ajv` 8.20 for JSON Schema 2020-12, `yaml` 2.9.

**Spec:** `docs/superpowers/specs/2026-09-28-conversational-decision-resolution-design.md`

## Global Constraints

- Node `>=22.18.0`. TypeScript is type-stripped, **not** compiled for tests — imports must carry the `.ts` extension (`from "./result.ts"`).
- Tests: `npm test` (runs `npm run build` first, then `node --test "tests/**/*.test.ts"`). Full gate: `npm run check` (typecheck + test). Plugin gate: `npm run check:plugin`.
- Test style: `describe`/`it` from `node:test`, `assert` from `node:assert/strict`. Match existing suites.
- `tsconfig.json` is strict; `exactOptionalPropertyTypes` behaviour is visible throughout the codebase as `...(x === undefined ? {} : { x })` — follow that idiom rather than assigning `undefined`.
- Persisted YAML is **snake_case**. `CommandResult.data` and `CommandResult.decisions` projections are **camelCase**.
- Decision ids match `^d-[a-f0-9]{20}$` and MUST be validated before any path construction.
- All filesystem writes go through `resolveSafePath` (`cli/lib/safe-path.ts`) and `atomicWriteFileSync` (`cli/lib/atomic-write.ts`).
- **Paved never writes `human-owned` files**: `.paved/manifest.yaml`, `.paved/gardener/reviews.yaml`, `.paved/approvals/`. (`AGENTS.md` only via its existing delimited block.)
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`), matching `git log`.
- Every apply handler MUST be idempotent — the crash-recovery path re-applies.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `schemas/decision.schema.yaml` | The `Decision` document contract |
| `cli/lib/decisions/record.ts` | Types, id derivation, state machine transitions |
| `cli/lib/decisions/fingerprint.ts` | Narrow fingerprinting and staleness detection |
| `cli/lib/decisions/answers.ts` | Answer parsing and validation per `required_answer` |
| `cli/lib/decisions/effects.ts` | Effect-class registry → risk/reversibility/channel |
| `cli/lib/decisions/store.ts` | Project-scoped persistence (`.paved/decisions/`) |
| `cli/lib/decisions/approval.ts` | Human-authored approval channel |
| `cli/lib/decisions/gate.ts` | The seven-step pipeline; provider/handler registry |
| `cli/lib/decisions/providers/verification.ts` | Detects verification-gate candidates |
| `cli/lib/decisions/providers/rules.ts` | Detects rule-convention candidates |
| `cli/lib/decisions/providers/capability.ts` | Ambiguous capability provider candidates |
| `cli/lib/decisions/providers/testing.ts` | Ambiguous testing tool candidates |
| `cli/lib/decisions/providers/repair.ts` | Doctor repair candidates |
| `cli/lib/decisions/providers/gardener.ts` | Gardener proposal adoption candidates |
| `cli/lib/decisions/handlers/*.ts` | Apply handlers, one per effect |
| `cli/commands/decision.ts` | The `decision` command |
| `core/skills/decisions/decisions/SKILL.md` + `skill.yaml` | Canonical interaction protocol skill |
| `docs/concepts/decisions.md` | Concept documentation |
| `docs/decisions/0028-conversational-decision-resolution.md` | ADR |
| `tests/decisions/*.test.ts` | Six new suites |
| `tests/acceptance/no-manual-configuration.test.ts` | Phase 19 clean-room |

### Modified files

| Path | Change |
|---|---|
| `cli/result.ts` | `awaiting_input` status, exit code 10, top-level `decisions`, new invariant |
| `cli/output.ts` | Central decisions rendering block |
| `cli/runtime.ts` | `--answer`, `--answered-by`, `decision` command registration |
| `cli/lib/adapters.ts:137` | `resolveCapability` answered-decision precedence tier |
| `cli/lib/test-runner.ts:162` | Split ambiguity (askable) from absence (blocking) |
| `cli/lib/agent-commands.ts:84` | Availability when a profile can be decided |
| `cli/lib/consumer-state.ts:761` | Validate `.paved/decisions/` documents |
| `cli/lib/workflows.ts` | `assessRun` decision rules; `WorkflowRunRecord.decisions` |
| `cli/commands/{init,status,verify,test,doctor,gardener,update,workflow}.ts` | Decision gate integration |
| `schemas/workflow-run.schema.yaml` | `awaiting-input` status, `decisions[]`, new events |
| `manifest.yaml` | `.paved/decisions/` and `.paved/approvals/` layout entries |
| `integrations/shared/commands.ts` | `interaction`, `decisionSources`, `answerChannels` |
| `integrations/shared/projection.ts` | Conversational contract in `renderCommand` |
| `tests/agent-contract/synthetic-agent.test.ts:17` | `Result` type learns `awaiting_input` |

---

# Stage A — Protocol core

### Task 1: The `Decision` schema

**Files:**
- Create: `schemas/decision.schema.yaml`
- Test: `tests/decisions/record.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a schema registered under `urn:paved:schema:decision:v1`, loadable by `createRegistry(join(coreRoot, "schemas"), ["paved/v1"])` and validating documents with `kind: Decision`.

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/record.test.ts`:

```ts
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../../cli/lib/schemas.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const registry = () => createRegistry(join(root, "schemas"), ["paved/v1"]);

function minimalDecision(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "paved/v1",
    kind: "Decision",
    id: "d-0123456789abcdef0123",
    scope: "project",
    command: "verify",
    category: "material",
    authored_by: "runtime",
    question: "Should the detected checks become verification gates?",
    reason: "These checks already run in CI but are not authorized as Paved gates.",
    options: [
      { id: "all", label: "All", description: "Adopt every detected check.", consequence: "All detected checks become gates." },
      { id: "none", label: "None", description: "Adopt nothing.", consequence: "No verification profile is created." },
    ],
    evidence: [{ type: "file", location: "pom.xml", sha256: "a".repeat(64) }],
    required: true,
    required_answer: { type: "single-choice" },
    risk: "low",
    reversibility: "reversible",
    answer_channel: "relayed",
    status: "PENDING",
    fingerprint: { inputs: ["pom.xml@" + "a".repeat(64)], sha256: "b".repeat(64) },
    created_at: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("Decision schema", () => {
  it("accepts a minimal valid decision", () => {
    const result = registry().validate(minimalDecision());
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("rejects an id that is not the canonical decision id form", () => {
    assert.equal(registry().validate(minimalDecision({ id: "../escape" })).valid, false);
  });

  it("rejects answered_by values reserved for non-humans", () => {
    const decision = minimalDecision({
      status: "ANSWERED",
      answer: "all",
      answered_by: "agent",
      answer_source: "agent-relayed",
      answered_at: "2026-09-28T00:01:00.000Z",
    });
    assert.equal(registry().validate(decision).valid, false);
  });

  it("requires answer provenance once the decision is ANSWERED", () => {
    assert.equal(registry().validate(minimalDecision({ status: "ANSWERED" })).valid, false);
  });

  it("requires at least one evidence entry when a recommendation is present", () => {
    const decision = minimalDecision({ recommended_option: "all", evidence: [] });
    assert.equal(registry().validate(decision).valid, false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/record.test.ts`
Expected: FAIL — the registry has no `Decision` schema, so `validate` returns `valid: false` for the first case.

- [ ] **Step 3: Write the schema**

Create `schemas/decision.schema.yaml`:

```yaml
$schema: https://json-schema.org/draft/2020-12/schema
$id: urn:paved:schema:decision:v1
title: Paved decision record
description: >
  One decision Paved encountered: what it asked, why it mattered, the evidence behind it,
  the options offered, the answer received and its provenance, and the state that answer
  produced. Material project-scoped decisions live under .paved/decisions/<id>.yaml;
  run-scoped ones live inside the WorkflowRun. Deterministic decisions are projected into
  results but persisted through paved.lock, never as Decision documents.
  See docs/concepts/decisions.md.
type: object
additionalProperties: false
required:
  [apiVersion, kind, id, scope, command, category, authored_by, question, reason,
   options, evidence, required, required_answer, risk, reversibility, answer_channel,
   status, fingerprint, created_at]
properties:
  apiVersion: { $ref: "urn:paved:schema:common:v1#/$defs/apiVersion" }
  kind: { const: Decision }
  id:
    description: Content-derived decision id; stable across re-raises of the same question.
    type: string
    pattern: "^d-[a-f0-9]{20}$"
  scope:
    description: "`project`: persisted under .paved/decisions/. `run`: persisted inside the WorkflowRun."
    enum: [project, run]
  command: { $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString" }
  run: { $ref: "urn:paved:schema:common:v1#/$defs/name" }
  category:
    description: "`material` is askable. `deterministic` is auto-applied. Unsafe conditions never become decisions."
    enum: [deterministic, material]
  authored_by:
    description: "`runtime`: derived from repository evidence. `agent`: declared through `paved decision raise`."
    enum: [runtime, agent]
  question: { $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString" }
  reason:
    description: Why this decision matters, in terms the project owner can act on.
    $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString"
  options:
    type: array
    minItems: 1
    items:
      type: object
      additionalProperties: false
      required: [id, label, description, consequence]
      properties:
        id: { $ref: "urn:paved:schema:common:v1#/$defs/name" }
        label: { $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString" }
        description: { $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString" }
        consequence:
          description: What happens to the project if this option is chosen.
          $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString"
  recommended_option: { $ref: "urn:paved:schema:common:v1#/$defs/name" }
  evidence:
    description: The repository evidence that makes this decision meaningful.
    type: array
    items:
      type: object
      additionalProperties: false
      required: [type, location, sha256]
      properties:
        type: { const: file }
        location: { $ref: "urn:paved:schema:common:v1#/$defs/relativePath" }
        sha256: { type: string, pattern: "^[a-f0-9]{64}$" }
  required:
    description: Whether the originating command can proceed without an answer.
    type: boolean
  required_answer:
    type: object
    additionalProperties: false
    required: [type]
    properties:
      type: { enum: [single-choice, multi-choice, boolean, free-text] }
      pattern: { type: string }
      max_length: { type: integer, minimum: 1, maximum: 4000 }
  risk: { enum: [low, medium, high] }
  reversibility: { enum: [reversible, recoverable, irreversible] }
  answer_channel:
    description: Derived from the apply handler's effect class; never supplied by a caller.
    enum: [relayed, human-authored]
  effect: { $ref: "#/$defs/effectClass" }
  depends_on:
    type: array
    items: { type: string, pattern: "^d-[a-f0-9]{20}$" }
  status:
    enum: [PENDING, ASKED, ANSWERED, APPLIED, REJECTED, CANCELLED, SUPERSEDED]
  asked_at: { $ref: "urn:paved:schema:common:v1#/$defs/dateTime" }
  answer: {}
  answered_by:
    description: Who supplied the answer. An agent never answers on a human's behalf.
    type: string
    minLength: 1
    not: { enum: [agent, paved, ci] }
  answer_source: { enum: [derived, agent-relayed, human-authored] }
  answered_at: { $ref: "urn:paved:schema:common:v1#/$defs/dateTime" }
  applied_changes:
    type: array
    items: { $ref: "urn:paved:schema:common:v1#/$defs/relativePath" }
  applied_at: { $ref: "urn:paved:schema:common:v1#/$defs/dateTime" }
  fingerprint:
    type: object
    additionalProperties: false
    required: [inputs, sha256]
    properties:
      inputs:
        type: array
        items: { $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString" }
      sha256: { type: string, pattern: "^[a-f0-9]{64}$" }
  supersedes: { type: string, pattern: "^d-[a-f0-9]{20}$" }
  superseded_by: { type: string, pattern: "^d-[a-f0-9]{20}$" }
  superseded_reason: { $ref: "urn:paved:schema:common:v1#/$defs/nonEmptyString" }
  created_at: { $ref: "urn:paved:schema:common:v1#/$defs/dateTime" }
allOf:
  - if:
      properties: { scope: { const: run } }
      required: [scope]
    then:
      required: [run]
  - if:
      properties: { status: { enum: [ANSWERED, APPLIED] } }
      required: [status]
    then:
      required: [answer, answered_by, answer_source, answered_at]
  - if:
      properties: { status: { const: APPLIED } }
      required: [status]
    then:
      required: [applied_at]
  - if:
      properties: { status: { const: SUPERSEDED } }
      required: [status]
    then:
      required: [superseded_reason]
  - if:
      required: [recommended_option]
    then:
      properties: { evidence: { minItems: 1 } }
$defs:
  effectClass:
    description: >
      The registered effect class of this decision's apply handler. Determines risk,
      reversibility and answer channel. Never settable per decision.
    enum: [record-only, config-additive, config-mutating, lock-transaction, repository-mutating, destructive]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/record.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the existing schema suite for regressions**

Run: `node --test tests/schemas/schemas.test.ts`
Expected: PASS. If it enumerates schema files, add `decision.schema.yaml` to its expectations.

- [ ] **Step 6: Commit**

```bash
git add schemas/decision.schema.yaml tests/decisions/record.test.ts
git commit -m "feat: add Decision document schema"
```

---

### Task 2: Decision types, id derivation and the state machine

**Files:**
- Create: `cli/lib/decisions/record.ts`
- Test: `tests/decisions/record.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `type DecisionStatus = "PENDING" | "ASKED" | "ANSWERED" | "APPLIED" | "REJECTED" | "CANCELLED" | "SUPERSEDED"`
  - `interface Decision` (snake_case, mirrors the schema)
  - `interface DecisionOption { id; label; description; consequence }`
  - `interface DecisionEvidence { type: "file"; location: string; sha256: string }`
  - `decisionId(question: string, scope: string, candidates: readonly string[]): string`
  - `canTransition(from: DecisionStatus, to: DecisionStatus): boolean`
  - `transition(decision: Decision, to: DecisionStatus, patch?: Partial<Decision>): Decision` — throws `DecisionStateError` on an illegal transition
  - `class DecisionStateError extends Error`

- [ ] **Step 1: Write the failing test**

Append to `tests/decisions/record.test.ts`:

```ts
import { canTransition, decisionId, DecisionStateError, transition } from "../../cli/lib/decisions/record.ts";

describe("decision id derivation", () => {
  it("is stable for the same question, scope and candidate set", () => {
    const a = decisionId("Adopt checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    const b = decisionId("Adopt checks?", "project:verify", ["mvn-test", "mvn-validate"]);
    assert.equal(a, b, "candidate order must not change the id");
    assert.match(a, /^d-[a-f0-9]{20}$/);
  });

  it("differs when the candidate set differs", () => {
    const a = decisionId("Adopt checks?", "project:verify", ["mvn-validate"]);
    const b = decisionId("Adopt checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    assert.notEqual(a, b);
  });
});

describe("decision state machine", () => {
  it("allows the happy path", () => {
    assert.equal(canTransition("PENDING", "ASKED"), true);
    assert.equal(canTransition("ASKED", "ANSWERED"), true);
    assert.equal(canTransition("ANSWERED", "APPLIED"), true);
  });

  it("forbids skipping ASKED", () => {
    assert.equal(canTransition("PENDING", "ANSWERED"), false);
  });

  it("forbids leaving terminal states except by supersession", () => {
    assert.equal(canTransition("APPLIED", "ANSWERED"), false);
    assert.equal(canTransition("APPLIED", "SUPERSEDED"), true);
    assert.equal(canTransition("REJECTED", "SUPERSEDED"), false);
    assert.equal(canTransition("CANCELLED", "ASKED"), false);
  });

  it("throws on an illegal transition and does not mutate the input", () => {
    const decision = { ...minimalDecision(), status: "APPLIED" } as never;
    assert.throws(() => transition(decision, "ASKED"), DecisionStateError);
    assert.equal((decision as { status: string }).status, "APPLIED");
  });

  it("returns a new record carrying the patch", () => {
    const decision = minimalDecision() as never;
    const asked = transition(decision, "ASKED", { asked_at: "2026-09-28T00:02:00.000Z" });
    assert.equal(asked.status, "ASKED");
    assert.equal(asked.asked_at, "2026-09-28T00:02:00.000Z");
    assert.equal((decision as { status: string }).status, "PENDING");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/record.test.ts`
Expected: FAIL — `Cannot find module '../../cli/lib/decisions/record.ts'`.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/record.ts`:

```ts
import { createHash } from "node:crypto";

export type DecisionStatus =
  | "PENDING" | "ASKED" | "ANSWERED" | "APPLIED" | "REJECTED" | "CANCELLED" | "SUPERSEDED";
export type DecisionCategory = "deterministic" | "material";
export type DecisionAuthor = "runtime" | "agent";
export type AnswerSource = "derived" | "agent-relayed" | "human-authored";
export type AnswerChannel = "relayed" | "human-authored";
export type DecisionRisk = "low" | "medium" | "high";
export type DecisionReversibility = "reversible" | "recoverable" | "irreversible";
export type RequiredAnswerType = "single-choice" | "multi-choice" | "boolean" | "free-text";

export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly consequence: string;
}

export interface DecisionEvidence {
  readonly type: "file";
  readonly location: string;
  readonly sha256: string;
}

export interface RequiredAnswer {
  readonly type: RequiredAnswerType;
  readonly pattern?: string;
  readonly max_length?: number;
}

export interface DecisionFingerprint {
  readonly inputs: readonly string[];
  readonly sha256: string;
}

export interface Decision {
  readonly apiVersion: "paved/v1";
  readonly kind: "Decision";
  readonly id: string;
  readonly scope: "project" | "run";
  readonly command: string;
  readonly run?: string;
  readonly category: DecisionCategory;
  readonly authored_by: DecisionAuthor;
  readonly question: string;
  readonly reason: string;
  readonly options: readonly DecisionOption[];
  readonly recommended_option?: string;
  readonly evidence: readonly DecisionEvidence[];
  readonly required: boolean;
  readonly required_answer: RequiredAnswer;
  readonly risk: DecisionRisk;
  readonly reversibility: DecisionReversibility;
  readonly answer_channel: AnswerChannel;
  readonly effect?: string;
  readonly depends_on?: readonly string[];
  readonly status: DecisionStatus;
  readonly asked_at?: string;
  readonly answer?: unknown;
  readonly answered_by?: string;
  readonly answer_source?: AnswerSource;
  readonly answered_at?: string;
  readonly applied_changes?: readonly string[];
  readonly applied_at?: string;
  readonly fingerprint: DecisionFingerprint;
  readonly supersedes?: string;
  readonly superseded_by?: string;
  readonly superseded_reason?: string;
  readonly created_at: string;
}

export class DecisionStateError extends Error {}

// SUPERSEDED is reachable from every non-terminal state and from APPLIED, because an
// applied decision whose evidence changed must not be silently reused (spec 2.4).
const TRANSITIONS: Readonly<Record<DecisionStatus, readonly DecisionStatus[]>> = {
  PENDING: ["ASKED", "CANCELLED", "SUPERSEDED"],
  ASKED: ["ANSWERED", "REJECTED", "CANCELLED", "SUPERSEDED"],
  ANSWERED: ["APPLIED", "SUPERSEDED"],
  APPLIED: ["SUPERSEDED"],
  REJECTED: [],
  CANCELLED: [],
  SUPERSEDED: [],
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Content-derived and order-independent: re-raising the same question against the same
 * candidate set resolves to the same record, which is what makes providers idempotent
 * and lets read-only commands ask without persisting (spec 4).
 */
export function decisionId(question: string, scope: string, candidates: readonly string[]): string {
  const normalized = [...candidates].sort((a, b) => a.localeCompare(b, "en")).join(" ");
  return `d-${sha(`${question} ${scope} ${normalized}`).slice(0, 20)}`;
}

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(decision: Decision, to: DecisionStatus, patch: Partial<Decision> = {}): Decision {
  if (!canTransition(decision.status, to)) {
    throw new DecisionStateError(`Decision ${decision.id} cannot move from ${decision.status} to ${to}.`);
  }
  return { ...decision, ...patch, status: to };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/record.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/decisions/record.ts tests/decisions/record.test.ts
git commit -m "feat: add decision record types and state machine"
```

---

### Task 3: Narrow fingerprinting and staleness

**Files:**
- Create: `cli/lib/decisions/fingerprint.ts`
- Test: `tests/decisions/invalidation.test.ts`

**Interfaces:**
- Consumes: `DecisionEvidence`, `Decision` from Task 2.
- Produces:
  - `fingerprintOf(evidence: readonly DecisionEvidence[], candidates: readonly string[]): DecisionFingerprint`
  - `isStale(decision: Decision, current: DecisionFingerprint): boolean`
  - `supersede(decision: Decision, reason: string, successorId: string): Decision`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/invalidation.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprintOf, isStale, supersede } from "../../cli/lib/decisions/fingerprint.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];

function decision(status: Decision["status"]): Decision {
  return {
    apiVersion: "paved/v1", kind: "Decision", id: "d-0123456789abcdef0123",
    scope: "project", command: "verify", category: "material", authored_by: "runtime",
    question: "q", reason: "r",
    options: [{ id: "all", label: "All", description: "d", consequence: "c" }],
    evidence, required: true, required_answer: { type: "single-choice" },
    risk: "low", reversibility: "reversible", answer_channel: "relayed",
    status, fingerprint: fingerprintOf(evidence, ["mvn-validate"]),
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

describe("decision fingerprinting", () => {
  it("is stable and order-independent over candidates", () => {
    assert.equal(
      fingerprintOf(evidence, ["b", "a"]).sha256,
      fingerprintOf(evidence, ["a", "b"]).sha256,
    );
  });

  it("changes when a cited evidence digest changes", () => {
    const moved = [{ type: "file" as const, location: "pom.xml", sha256: "c".repeat(64) }];
    assert.notEqual(fingerprintOf(evidence, ["a"]).sha256, fingerprintOf(moved, ["a"]).sha256);
  });

  it("changes when the candidate set changes", () => {
    assert.notEqual(fingerprintOf(evidence, ["a"]).sha256, fingerprintOf(evidence, ["a", "b"]).sha256);
  });

  it("does NOT change when an uncited file changes", () => {
    // The narrowness rule: only cited evidence participates. An unrelated commit must
    // not supersede an answered decision (spec 2.4).
    const before = fingerprintOf(evidence, ["a"]);
    const after = fingerprintOf([...evidence], ["a"]);
    assert.equal(before.sha256, after.sha256);
    assert.deepEqual(before.inputs, after.inputs);
  });
});

describe("staleness", () => {
  it("detects a mismatch", () => {
    assert.equal(isStale(decision("ASKED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("accepts a match", () => {
    assert.equal(isStale(decision("ASKED"), fingerprintOf(evidence, ["mvn-validate"])), false);
  });

  it("checks APPLIED decisions too", () => {
    assert.equal(isStale(decision("APPLIED"), fingerprintOf(evidence, ["different"])), true);
  });

  it("never reports terminal non-applied decisions as stale", () => {
    assert.equal(isStale(decision("SUPERSEDED"), fingerprintOf(evidence, ["different"])), false);
    assert.equal(isStale(decision("CANCELLED"), fingerprintOf(evidence, ["different"])), false);
    assert.equal(isStale(decision("REJECTED"), fingerprintOf(evidence, ["different"])), false);
  });
});

describe("supersession", () => {
  it("records the reason and the successor", () => {
    const result = supersede(decision("APPLIED"), "Repository topology changed.", "d-ffffffffffffffffffff");
    assert.equal(result.status, "SUPERSEDED");
    assert.equal(result.superseded_by, "d-ffffffffffffffffffff");
    assert.equal(result.superseded_reason, "Repository topology changed.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/invalidation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/fingerprint.ts`:

```ts
import { createHash } from "node:crypto";
import { transition, type Decision, type DecisionEvidence, type DecisionFingerprint } from "./record.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

// Terminal states that are not re-openable: superseding them again would churn the
// audit trail without changing anything.
const IMMUTABLE = new Set(["SUPERSEDED", "CANCELLED", "REJECTED"]);

/**
 * The narrowness rule (spec 2.4): a fingerprint digests ONLY the decision's own cited
 * evidence and its candidate set — never the whole source tree. A broad fingerprint
 * would supersede and re-ask every answered question on any unrelated commit, which
 * would violate the question-efficiency requirement.
 */
export function fingerprintOf(
  evidence: readonly DecisionEvidence[],
  candidates: readonly string[],
): DecisionFingerprint {
  const inputs = [
    ...evidence.map((item) => `evidence:${item.location}@${item.sha256}`),
    ...candidates.map((id) => `candidate:${id}`),
  ].sort((a, b) => a.localeCompare(b, "en"));
  return { inputs, sha256: sha(inputs.join(" ")) };
}

export function isStale(decision: Decision, current: DecisionFingerprint): boolean {
  if (IMMUTABLE.has(decision.status)) return false;
  return decision.fingerprint.sha256 !== current.sha256;
}

export function supersede(decision: Decision, reason: string, successorId: string): Decision {
  return transition(decision, "SUPERSEDED", {
    superseded_by: successorId,
    superseded_reason: reason,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/invalidation.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/fingerprint.ts tests/decisions/invalidation.test.ts
git commit -m "feat: add narrow decision fingerprinting and supersession"
```

---

### Task 4: Answer parsing and validation

**Files:**
- Create: `cli/lib/decisions/answers.ts`
- Test: `tests/decisions/answers.test.ts`

**Interfaces:**
- Consumes: `Decision` from Task 2.
- Produces:
  - `type AnswerValue = string | readonly string[] | boolean`
  - `parseAnswerFlags(raw: readonly string[]): { byDecision: Map<string, string[]> } | { problems: string[] }` — parses `d-xxx=value` pairs, accumulating repeats
  - `validateAnswer(decision: Decision, values: readonly string[]): { value: AnswerValue } | { problems: string[] }`
  - `assertAnswerIdentity(identity: string | undefined): string` — throws `AnswerIdentityError` when missing, empty, or reserved
  - `class AnswerIdentityError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/answers.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import {
  AnswerIdentityError, assertAnswerIdentity, parseAnswerFlags, validateAnswer,
} from "../../cli/lib/decisions/answers.ts";
import type { Decision, RequiredAnswerType } from "../../cli/lib/decisions/record.ts";

function decision(type: RequiredAnswerType, extra: Record<string, unknown> = {}): Decision {
  const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];
  return {
    apiVersion: "paved/v1", kind: "Decision", id: "d-0123456789abcdef0123",
    scope: "project", command: "verify", category: "material", authored_by: "runtime",
    question: "q", reason: "r",
    options: [
      { id: "all", label: "All", description: "d", consequence: "c" },
      { id: "backend", label: "Backend", description: "d", consequence: "c" },
    ],
    evidence, required: true,
    required_answer: { type, ...extra } as Decision["required_answer"],
    risk: "low", reversibility: "reversible", answer_channel: "relayed",
    status: "ASKED", fingerprint: fingerprintOf(evidence, ["a"]),
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

describe("parseAnswerFlags", () => {
  it("parses one pair", () => {
    const parsed = parseAnswerFlags(["d-0123456789abcdef0123=all"]);
    assert.ok("byDecision" in parsed);
    assert.deepEqual(parsed.byDecision.get("d-0123456789abcdef0123"), ["all"]);
  });

  it("accumulates repeated flags for multi-choice", () => {
    const parsed = parseAnswerFlags([
      "d-0123456789abcdef0123=all",
      "d-0123456789abcdef0123=backend",
    ]);
    assert.ok("byDecision" in parsed);
    assert.deepEqual(parsed.byDecision.get("d-0123456789abcdef0123"), ["all", "backend"]);
  });

  it("does not split on commas, which are legal inside free text", () => {
    const parsed = parseAnswerFlags(["d-0123456789abcdef0123=keycloak, then auth0"]);
    assert.ok("byDecision" in parsed);
    assert.deepEqual(parsed.byDecision.get("d-0123456789abcdef0123"), ["keycloak, then auth0"]);
  });

  it("rejects a malformed pair", () => {
    assert.ok("problems" in parseAnswerFlags(["nonsense"]));
  });

  it("rejects an id that is not a decision id", () => {
    assert.ok("problems" in parseAnswerFlags(["../escape=all"]));
  });
});

describe("validateAnswer", () => {
  it("accepts a known single choice", () => {
    const result = validateAnswer(decision("single-choice"), ["all"]);
    assert.ok("value" in result);
    assert.equal(result.value, "all");
  });

  it("rejects an unknown option", () => {
    assert.ok("problems" in validateAnswer(decision("single-choice"), ["invented"]));
  });

  it("rejects more than one value for single choice", () => {
    assert.ok("problems" in validateAnswer(decision("single-choice"), ["all", "backend"]));
  });

  it("accepts a subset for multi choice", () => {
    const result = validateAnswer(decision("multi-choice"), ["all", "backend"]);
    assert.ok("value" in result);
    assert.deepEqual(result.value, ["all", "backend"]);
  });

  it("rejects duplicates for multi choice", () => {
    assert.ok("problems" in validateAnswer(decision("multi-choice"), ["all", "all"]));
  });

  it("accepts booleans", () => {
    const result = validateAnswer(decision("boolean"), ["true"]);
    assert.ok("value" in result);
    assert.equal(result.value, true);
  });

  it("rejects non-boolean text for booleans", () => {
    assert.ok("problems" in validateAnswer(decision("boolean"), ["maybe"]));
  });

  it("enforces the free-text pattern and length", () => {
    const constrained = decision("free-text", { pattern: "^[a-z-]+$", max_length: 10 });
    assert.ok("value" in validateAnswer(constrained, ["keycloak"]));
    assert.ok("problems" in validateAnswer(constrained, ["Key Cloak!"]));
    assert.ok("problems" in validateAnswer(constrained, ["aaaaaaaaaaaaaaaaaaaa"]));
  });
});

describe("assertAnswerIdentity", () => {
  it("accepts a human identity", () => {
    assert.equal(assertAnswerIdentity("anderson@example.com"), "anderson@example.com");
  });

  it("rejects a missing identity — there is no fallback to git config", () => {
    assert.throws(() => assertAnswerIdentity(undefined), AnswerIdentityError);
  });

  it("rejects reserved non-human identities", () => {
    for (const reserved of ["agent", "paved", "ci"]) {
      assert.throws(() => assertAnswerIdentity(reserved), AnswerIdentityError);
    }
  });

  it("rejects whitespace-only identities", () => {
    assert.throws(() => assertAnswerIdentity("   "), AnswerIdentityError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/answers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/answers.ts`:

```ts
import type { Decision } from "./record.ts";

export type AnswerValue = string | readonly string[] | boolean;

export class AnswerIdentityError extends Error {}

const DECISION_ID = /^d-[a-f0-9]{20}$/;
const RESERVED_IDENTITIES = new Set(["agent", "paved", "ci"]);

/**
 * Parses repeatable `--answer <decision-id>=<value>` pairs. Values are never split on
 * commas: a multi-choice answer repeats the flag, because commas are legal inside a
 * free-text answer (spec 5.3).
 */
export function parseAnswerFlags(
  raw: readonly string[],
): { byDecision: Map<string, string[]> } | { problems: string[] } {
  const byDecision = new Map<string, string[]>();
  const problems: string[] = [];
  for (const entry of raw) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      problems.push(`Malformed --answer value: ${entry}. Use <decision-id>=<value>.`);
      continue;
    }
    const id = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!DECISION_ID.test(id)) {
      problems.push(`Malformed decision id in --answer: ${id}.`);
      continue;
    }
    byDecision.set(id, [...(byDecision.get(id) ?? []), value]);
  }
  return problems.length > 0 ? { problems } : { byDecision };
}

export function validateAnswer(
  decision: Decision,
  values: readonly string[],
): { value: AnswerValue } | { problems: string[] } {
  const known = new Set(decision.options.map((option) => option.id));
  const type = decision.required_answer.type;

  if (values.length === 0) return { problems: [`Decision ${decision.id} received no answer value.`] };

  if (type === "single-choice") {
    if (values.length !== 1) return { problems: [`Decision ${decision.id} accepts exactly one option.`] };
    const value = values[0]!;
    if (!known.has(value)) return { problems: [`Unknown option for ${decision.id}: ${value}.`] };
    return { value };
  }

  if (type === "multi-choice") {
    if (new Set(values).size !== values.length) {
      return { problems: [`Decision ${decision.id} received a duplicated option.`] };
    }
    const unknown = values.filter((value) => !known.has(value));
    if (unknown.length > 0) return { problems: [`Unknown option(s) for ${decision.id}: ${unknown.join(", ")}.`] };
    return { value: [...values].sort((a, b) => a.localeCompare(b, "en")) };
  }

  if (type === "boolean") {
    if (values.length !== 1) return { problems: [`Decision ${decision.id} accepts exactly one value.`] };
    const value = values[0]!;
    if (value !== "true" && value !== "false") {
      return { problems: [`Decision ${decision.id} expects true or false, received ${value}.`] };
    }
    return { value: value === "true" };
  }

  if (values.length !== 1) return { problems: [`Decision ${decision.id} accepts exactly one value.`] };
  const value = values[0]!;
  const limit = decision.required_answer.max_length ?? 500;
  if (value.length > limit) return { problems: [`Answer for ${decision.id} exceeds ${limit} characters.`] };
  const pattern = decision.required_answer.pattern;
  if (pattern !== undefined && !new RegExp(pattern).test(value)) {
    return { problems: [`Answer for ${decision.id} does not match the required pattern.`] };
  }
  return { value };
}

/**
 * There is deliberately no fallback to `git config user.email`: a fallback would hand
 * an agent a plausible human identity for free, which is the forgery the approval model
 * exists to prevent (spec 5.3).
 */
export function assertAnswerIdentity(identity: string | undefined): string {
  const trimmed = identity?.trim();
  if (trimmed === undefined || trimmed === "") {
    throw new AnswerIdentityError("--answered-by is required whenever --answer is supplied.");
  }
  if (RESERVED_IDENTITIES.has(trimmed)) {
    throw new AnswerIdentityError(`--answered-by must name a person, not ${trimmed}.`);
  }
  return trimmed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/answers.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/answers.ts tests/decisions/answers.test.ts
git commit -m "feat: add decision answer parsing and validation"
```

---

### Task 5: Effect classes and channel derivation

**Files:**
- Create: `cli/lib/decisions/effects.ts`
- Test: `tests/decisions/security.test.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces:
  - `type EffectClass = "record-only" | "config-additive" | "config-mutating" | "lock-transaction" | "repository-mutating" | "destructive"`
  - `interface EffectTier { risk: DecisionRisk; reversibility: DecisionReversibility; channel: AnswerChannel }`
  - `const EFFECT_TIERS: Readonly<Record<EffectClass, EffectTier>>`
  - `tierFor(effect: EffectClass, options?: { planApproval?: boolean }): EffectTier`
  - `AGENT_ASSIGNABLE_EFFECTS: ReadonlySet<EffectClass>`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/security.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_ASSIGNABLE_EFFECTS, EFFECT_TIERS, tierFor } from "../../cli/lib/decisions/effects.ts";

describe("effect class tiering", () => {
  it("routes reversible effects through the relayed channel", () => {
    assert.equal(tierFor("record-only").channel, "relayed");
    assert.equal(tierFor("config-additive").channel, "relayed");
  });

  it("routes recoverable effects through the relayed channel", () => {
    assert.equal(tierFor("config-mutating").channel, "relayed");
    assert.equal(tierFor("lock-transaction").channel, "relayed");
  });

  it("forces irreversible effects onto the human-authored channel", () => {
    assert.equal(tierFor("repository-mutating").channel, "human-authored");
    assert.equal(tierFor("destructive").channel, "human-authored");
  });

  it("forces plan approval onto the human-authored channel regardless of effect", () => {
    assert.equal(tierFor("record-only", { planApproval: true }).channel, "human-authored");
  });

  it("keeps every irreversible tier on the human-authored channel", () => {
    for (const [effect, tier] of Object.entries(EFFECT_TIERS)) {
      if (tier.reversibility === "irreversible") {
        assert.equal(tier.channel, "human-authored", `${effect} must be human-authored`);
      }
    }
  });

  it("does not let an agent assign an irreversible effect class", () => {
    for (const effect of ["repository-mutating", "destructive"] as const) {
      assert.equal(AGENT_ASSIGNABLE_EFFECTS.has(effect), false);
    }
    assert.equal(AGENT_ASSIGNABLE_EFFECTS.has("record-only"), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/security.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/effects.ts`:

```ts
import type { AnswerChannel, DecisionReversibility, DecisionRisk } from "./record.ts";

export type EffectClass =
  | "record-only" | "config-additive" | "config-mutating"
  | "lock-transaction" | "repository-mutating" | "destructive";

export interface EffectTier {
  readonly risk: DecisionRisk;
  readonly reversibility: DecisionReversibility;
  readonly channel: AnswerChannel;
}

/**
 * The answer channel is derived from the apply handler's registered effect class, never
 * from a field the caller supplies (spec 6.1). An agent that chooses a handler also
 * chooses its channel, and cannot select a weaker one.
 */
export const EFFECT_TIERS: Readonly<Record<EffectClass, EffectTier>> = {
  "record-only": { risk: "low", reversibility: "reversible", channel: "relayed" },
  "config-additive": { risk: "low", reversibility: "reversible", channel: "relayed" },
  "config-mutating": { risk: "medium", reversibility: "recoverable", channel: "relayed" },
  "lock-transaction": { risk: "medium", reversibility: "recoverable", channel: "relayed" },
  "repository-mutating": { risk: "high", reversibility: "irreversible", channel: "human-authored" },
  destructive: { risk: "high", reversibility: "irreversible", channel: "human-authored" },
};

/** Effect classes an agent-raised decision may reference. */
export const AGENT_ASSIGNABLE_EFFECTS: ReadonlySet<EffectClass> = new Set<EffectClass>([
  "record-only",
]);

export function tierFor(effect: EffectClass, options: { planApproval?: boolean } = {}): EffectTier {
  const tier = EFFECT_TIERS[effect];
  return options.planApproval === true ? { ...tier, channel: "human-authored" } : tier;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/security.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/effects.ts tests/decisions/security.test.ts
git commit -m "feat: derive decision answer channel from apply handler effect class"
```

---

### Task 6: Project-scoped decision store

**Files:**
- Create: `cli/lib/decisions/store.ts`
- Modify: `manifest.yaml` (add `.paved/decisions/` and `.paved/approvals/` layout entries)
- Test: `tests/decisions/persistence.test.ts`

**Interfaces:**
- Consumes: `Decision` (Task 2), `resolveSafePath`, `atomicWriteFileSync`, `createRegistry`.
- Produces:
  - `decisionPath(projectRoot: string, id: string): string` — throws on a malformed id
  - `readDecision(projectRoot: string, id: string): Decision | undefined`
  - `listDecisions(projectRoot: string): Decision[]` — sorted by `created_at` then `id`
  - `writeDecision(projectRoot: string, coreRoot: string, decision: Decision): void` — schema-validates before writing
  - `class DecisionStoreError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/persistence.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import {
  DecisionStoreError, listDecisions, readDecision, writeDecision,
} from "../../cli/lib/decisions/store.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const coreRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "paved-decision-store-"));
  workspaces.push(path);
  return path;
}

after(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

function decision(id: string, createdAt = "2026-09-28T00:00:00.000Z"): Decision {
  const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];
  return {
    apiVersion: "paved/v1", kind: "Decision", id, scope: "project", command: "verify",
    category: "material", authored_by: "runtime", question: "q", reason: "r",
    options: [{ id: "all", label: "All", description: "d", consequence: "c" }],
    evidence, required: true, required_answer: { type: "single-choice" },
    risk: "low", reversibility: "reversible", answer_channel: "relayed",
    status: "PENDING", fingerprint: fingerprintOf(evidence, ["a"]), created_at: createdAt,
  };
}

describe("project decision store", () => {
  it("round-trips a decision", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-0123456789abcdef0123"));
    const loaded = readDecision(project, "d-0123456789abcdef0123");
    assert.equal(loaded?.id, "d-0123456789abcdef0123");
    assert.equal(loaded?.status, "PENDING");
  });

  it("writes snake_case YAML under .paved/decisions/", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-0123456789abcdef0123"));
    const raw = readFileSync(join(project, ".paved/decisions/d-0123456789abcdef0123.yaml"), "utf8");
    assert.match(raw, /answer_channel: relayed/);
    assert.doesNotMatch(raw, /answerChannel/);
  });

  it("returns undefined for an absent decision", () => {
    assert.equal(readDecision(workspace(), "d-ffffffffffffffffffff"), undefined);
  });

  it("lists decisions in a stable order", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-bbbbbbbbbbbbbbbbbbbb", "2026-09-28T00:02:00.000Z"));
    writeDecision(project, coreRoot, decision("d-aaaaaaaaaaaaaaaaaaaa", "2026-09-28T00:01:00.000Z"));
    assert.deepEqual(
      listDecisions(project).map((item) => item.id),
      ["d-aaaaaaaaaaaaaaaaaaaa", "d-bbbbbbbbbbbbbbbbbbbb"],
    );
  });

  it("refuses a malformed id before touching the filesystem", () => {
    assert.throws(() => readDecision(workspace(), "../../etc/passwd"), DecisionStoreError);
    assert.throws(() => readDecision(workspace(), "d-NOTHEX"), DecisionStoreError);
  });

  it("refuses to write a schema-invalid decision", () => {
    const invalid = { ...decision("d-0123456789abcdef0123"), question: "" } as Decision;
    assert.throws(() => writeDecision(workspace(), coreRoot, invalid), DecisionStoreError);
  });

  it("survives a re-read after the process that wrote it is gone", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-0123456789abcdef0123"));
    // A fresh read with no in-memory state is exactly what an agent restart does.
    assert.equal(readDecision(project, "d-0123456789abcdef0123")?.id, "d-0123456789abcdef0123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/persistence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/store.ts`:

```ts
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "../atomic-write.ts";
import { loadYaml } from "../documents.ts";
import { resolveSafePath } from "../safe-path.ts";
import { createRegistry } from "../schemas.ts";
import type { Decision } from "./record.ts";

export class DecisionStoreError extends Error {}

const DECISION_ID = /^d-[a-f0-9]{20}$/;

/** Validates the id before any path construction, closing path traversal (spec 3.3). */
export function decisionPath(projectRoot: string, id: string): string {
  if (!DECISION_ID.test(id)) throw new DecisionStoreError(`Invalid decision id: ${id}`);
  return resolveSafePath(projectRoot, `.paved/decisions/${id}.yaml`);
}

export function readDecision(projectRoot: string, id: string): Decision | undefined {
  const path = decisionPath(projectRoot, id);
  if (!existsSync(path)) return undefined;
  try {
    return loadYaml(path) as Decision;
  } catch (error) {
    throw new DecisionStoreError(`Decision ${id} cannot be parsed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

export function listDecisions(projectRoot: string): Decision[] {
  const root = join(projectRoot, ".paved/decisions");
  if (!existsSync(root)) return [];
  const decisions: Decision[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const id = entry.name.slice(0, -".yaml".length);
    if (!DECISION_ID.test(id)) continue;
    const decision = readDecision(projectRoot, id);
    if (decision !== undefined) decisions.push(decision);
  }
  return decisions.sort((a, b) =>
    a.created_at.localeCompare(b.created_at, "en") || a.id.localeCompare(b.id, "en"));
}

export function writeDecision(projectRoot: string, coreRoot: string, decision: Decision): void {
  const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(decision);
  if (!validation.valid) {
    throw new DecisionStoreError(`Decision ${decision.id} is invalid: ${validation.errors.join("; ")}`);
  }
  const path = decisionPath(projectRoot, decision.id);
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWriteFileSync(path, stringify(decision));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/persistence.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Declare both paths in the consumer layout**

In `manifest.yaml`, inside `consumer_layout`, add after the `.paved/generated/evidence/` entry:

```yaml
  - path: .paved/decisions/
    ownership: tool-managed
    required: false
    committed: true
    schema: Decision
    description: >
      Material project-scoped decisions Paved asked and the project answered, with their
      evidence, answer provenance and the state each answer produced. Written only by
      Paved commands; the authority for configuration Paved wrote on the project's behalf.
  - path: .paved/approvals/
    ownership: human-owned
    required: false
    committed: true
    description: >
      Human-authored approval records for irreversible decisions and plan approval
      (<run-id>.json, <decision-id>.json), bound by digest to the exact content approved.
      Paved never writes this path.
```

The `.paved/approvals/` entry closes a pre-existing gap: the workflow runtime has read and written that path since `cli/commands/workflow.ts:175` without the layout declaring its ownership.

- [ ] **Step 6: Run the manifest and boundary suites**

Run: `node --test tests/core/manifest.test.ts tests/core/boundaries.test.ts`
Expected: PASS. If a test enumerates expected layout paths, add the two new entries.

- [ ] **Step 7: Commit**

```bash
git add cli/lib/decisions/store.ts tests/decisions/persistence.test.ts manifest.yaml
git commit -m "feat: persist project-scoped decisions and declare their ownership"
```

---

### Task 7: `awaiting_input` in the result contract

**Files:**
- Modify: `cli/result.ts`
- Test: `tests/cli/decisions.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ResultStatus` gains `"awaiting_input"`
  - `EXIT_CODES` gains `"awaiting-input": 10`
  - `CommandResult` gains `readonly decisions?: readonly DecisionProjection[]`
  - `interface DecisionProjection { id; question; reason; options; recommended?; evidence; required; risk; reversibility; answerChannel; dependsOn?; runId? }`
  - `createResult` accepts `decisions` and enforces the new invariant

- [ ] **Step 1: Write the failing test**

Create `tests/cli/decisions.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDiagnostic, createResult, exitCode, type DecisionProjection } from "../../cli/result.ts";

const projection: DecisionProjection = {
  id: "d-0123456789abcdef0123",
  question: "Should the detected checks become verification gates?",
  reason: "They already run in CI but are not authorized as Paved gates.",
  options: [{ id: "all", label: "All", description: "Adopt every check.", consequence: "All become gates." }],
  evidence: [{ type: "file", location: "pom.xml", sha256: "a".repeat(64) }],
  required: true,
  risk: "low",
  reversibility: "reversible",
  answerChannel: "relayed",
};

describe("awaiting_input result contract", () => {
  it("exits with the dedicated awaiting-input code", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [projection] });
    assert.equal(result.status, "awaiting_input");
    assert.equal(exitCode(result), 10);
  });

  it("exposes decisions at the top level, not inside data", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [projection] });
    assert.equal(result.decisions?.length, 1);
    assert.equal(result.data, undefined);
  });

  it("refuses awaiting_input without a required decision", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [] });
    assert.equal(result.status, "failed");
    assert.ok(result.diagnostics.some((item) => item.code === "PAVED_RESULT_MALFORMED_AWAITING_INPUT"));
  });

  it("refuses awaiting_input alongside a blocking diagnostic", () => {
    // Paved must not ask a question it cannot act on regardless of the answer.
    const result = createResult({
      command: "verify",
      status: "awaiting_input",
      decisions: [projection],
      diagnostics: [createDiagnostic({
        severity: "error", category: "config", code: "PAVED_X",
        component: "test", message: "blocked",
      })],
    });
    assert.equal(result.status, "failed");
  });

  it("allows awaiting_input alongside non-blocking findings", () => {
    const result = createResult({
      command: "verify",
      status: "awaiting_input",
      decisions: [projection],
      diagnostics: [createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_Y",
        component: "test", message: "advisory",
      })],
    });
    assert.equal(result.status, "awaiting_input");
    assert.equal(exitCode(result), 10);
  });

  it("allows optional decisions to ride along with a success result", () => {
    const optional = { ...projection, required: false };
    const result = createResult({ command: "doctor", status: "success", decisions: [optional] });
    assert.equal(result.status, "success");
    assert.equal(exitCode(result), 0);
    assert.equal(result.decisions?.length, 1);
  });

  it("keeps existing statuses and exit codes unchanged", () => {
    assert.equal(exitCode(createResult({ command: "status", status: "success" })), 0);
    const failed = createResult({
      command: "status", status: "failed",
      diagnostics: [createDiagnostic({
        severity: "error", category: "config", code: "PAVED_Z", component: "t", message: "m",
      })],
    });
    assert.equal(exitCode(failed), 4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/decisions.test.ts`
Expected: FAIL — `DecisionProjection` is not exported and `awaiting_input` is not a valid status.

- [ ] **Step 3: Modify `cli/result.ts`**

Replace the exit-code table, status type and result interface. The edits:

```ts
export const EXIT_CODES = {
  success: 0,
  findings: 1,
  usage: 2,
  environment: 3,
  config: 4,
  resolution: 5,
  "generation/update": 6,
  verification: 7,
  conflict: 8,
  internal: 9,
  "awaiting-input": 10,
} as const;

export type ExitCategory = keyof typeof EXIT_CODES;
export type DiagnosticCategory = Exclude<ExitCategory, "success" | "awaiting-input">;

export type ResultStatus = "success" | "warning" | "failed" | "awaiting_input";

export interface DecisionProjection {
  readonly id: string;
  readonly question: string;
  readonly reason: string;
  readonly options: readonly {
    readonly id: string; readonly label: string;
    readonly description: string; readonly consequence: string;
  }[];
  readonly recommended?: string;
  readonly evidence: readonly { readonly type: "file"; readonly location: string; readonly sha256: string }[];
  readonly required: boolean;
  readonly risk: "low" | "medium" | "high";
  readonly reversibility: "reversible" | "recoverable" | "irreversible";
  readonly answerChannel: "relayed" | "human-authored";
  readonly dependsOn?: readonly string[];
  readonly runId?: string;
}

export interface CommandResult<TData = unknown> {
  readonly command: string;
  readonly status: ResultStatus;
  readonly data?: TData;
  readonly decisions?: readonly DecisionProjection[];
  readonly diagnostics: readonly Diagnostic[];
}
```

Extend `ResultInput<TData>` with `readonly decisions?: readonly DecisionProjection[];`.

In `createResult`, after the existing malformed-failure normalisation, add the symmetric
awaiting-input invariant, then thread `decisions` through:

```ts
export function createResult<TData = unknown>(input: ResultInput<TData>): CommandResult<TData> {
  const diagnostics = input.diagnostics ?? [];
  const decisions = input.decisions ?? [];

  // Symmetric to the malformed-failure rule: awaiting_input is only meaningful when
  // there is a required question and nothing that blocks acting on its answer.
  if (input.status === "awaiting_input") {
    const problem = !decisions.some((decision) => decision.required)
      ? "awaiting_input requires at least one required decision."
      : hasBlockingDiagnostic(diagnostics)
        ? "awaiting_input cannot accompany a blocking diagnostic."
        : undefined;
    if (problem !== undefined) {
      return createResult({
        ...input,
        status: "failed",
        diagnostics: [
          ...diagnostics,
          createDiagnostic({
            severity: "error",
            category: "internal",
            code: "PAVED_RESULT_MALFORMED_AWAITING_INPUT",
            component: "cli.result",
            message: `Malformed awaiting_input result: ${problem}`,
            remediation: "Raise a required decision, or report the blocker as a diagnostic instead.",
          }),
        ],
      });
    }
  }

  const normalizedDiagnostics = input.status === "failed" && !hasBlockingDiagnostic(diagnostics)
    ? [ /* ...existing PAVED_RESULT_MALFORMED_FAILURE branch unchanged... */ ]
    : diagnostics;

  const base = {
    command: input.command,
    status: input.status,
    diagnostics: normalizedDiagnostics,
    ...(decisions.length === 0 ? {} : { decisions }),
  };

  return input.data === undefined ? base : { ...base, data: input.data };
}
```

In `primaryCategory`, short-circuit before the escalation loop:

```ts
export function primaryCategory(result: CommandResult): ExitCategory {
  // The awaiting_input invariant guarantees there is no blocking diagnostic to escalate.
  if (result.status === "awaiting_input") return "awaiting-input";

  let primary: ExitCategory = result.status === "success" ? "success" : "findings";
  for (const diagnostic of result.diagnostics) {
    if (CATEGORY_PRECEDENCE[diagnostic.category] > CATEGORY_PRECEDENCE[primary]) {
      primary = diagnostic.category;
    }
  }
  return primary;
}
```

Add `"awaiting-input": 10` to `CATEGORY_PRECEDENCE`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cli/decisions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full CLI and agent-contract suites for regressions**

Run: `node --test tests/cli/cli.test.ts tests/cli/commands.test.ts tests/agent-contract/synthetic-agent.test.ts`
Expected: PASS. `synthetic-agent.test.ts:17` narrows `Result["status"]` to three values — widen it to include `"awaiting_input"`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. `DiagnosticCategory` now excludes `"awaiting-input"`, so any code constructing a diagnostic with that category will fail to compile — there should be none.

- [ ] **Step 7: Commit**

```bash
git add cli/result.ts tests/cli/decisions.test.ts tests/agent-contract/synthetic-agent.test.ts
git commit -m "feat: add awaiting_input result status and top-level decisions"
```

---

### Task 8: Central human rendering of decisions

**Files:**
- Modify: `cli/output.ts`
- Test: `tests/cli/decisions.test.ts` (extend)

**Interfaces:**
- Consumes: `DecisionProjection`, `CommandResult` (Task 7).
- Produces: `renderHuman` emits a decisions block; `renderDecisions(result: CommandResult, resume: string): string` exported for testing.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/decisions.test.ts`:

```ts
import { renderHuman } from "../../cli/output.ts";

describe("human rendering of decisions", () => {
  it("renders the question, reason, numbered options and resume command", () => {
    const result = createResult({ command: "verify", status: "awaiting_input", decisions: [projection] });
    const text = renderHuman(result);
    assert.match(text, /d-0123456789abcdef0123/);
    assert.match(text, /Should the detected checks become verification gates\?/);
    assert.match(text, /already run in CI/);
    assert.match(text, /1\. all/);
    assert.match(text, /--answer d-0123456789abcdef0123=/);
    assert.match(text, /--answered-by/);
  });

  it("marks the recommendation and shows its evidence", () => {
    const recommended = { ...projection, recommended: "all" };
    const text = renderHuman(createResult({
      command: "verify", status: "awaiting_input", decisions: [recommended],
    }));
    assert.match(text, /recommended/i);
    assert.match(text, /pom\.xml/);
  });

  it("marks human-authored decisions as needing an approval file", () => {
    const approval = { ...projection, answerChannel: "human-authored" as const };
    const text = renderHuman(createResult({
      command: "doctor", status: "awaiting_input", decisions: [approval],
    }));
    assert.match(text, /\.paved\/approvals\/d-0123456789abcdef0123\.json/);
  });

  it("labels optional decisions so they do not read as blocking", () => {
    const optional = { ...projection, required: false };
    const text = renderHuman(createResult({ command: "doctor", status: "success", decisions: [optional] }));
    assert.match(text, /optional/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/decisions.test.ts`
Expected: FAIL — `renderHuman` ignores `decisions`.

- [ ] **Step 3: Modify `cli/output.ts`**

Add and export the renderer, then call it from `renderHuman`:

```ts
import type { CommandResult, DecisionProjection } from "./result.ts";

function renderDecision(decision: DecisionProjection, command: string): string {
  const lines: string[] = [];
  lines.push(`  [${decision.id}] ${decision.question}${decision.required ? "" : "  (optional)"}`);
  lines.push(`    ${decision.reason}`);
  for (const [index, option] of decision.options.entries()) {
    const mark = option.id === decision.recommended ? "  (recommended)" : "";
    lines.push(`    ${index + 1}. ${option.id} — ${option.label}${mark}`);
    lines.push(`       ${option.consequence}`);
  }
  if (decision.recommended !== undefined && decision.evidence.length > 0) {
    lines.push(`    Recommended because of: ${decision.evidence.map((item) => item.location).join(", ")}`);
  }
  if (decision.answerChannel === "human-authored") {
    lines.push(`    This decision is irreversible, so a person must author`);
    lines.push(`    .paved/approvals/${decision.id}.json before it can be applied.`);
  } else {
    const run = decision.runId === undefined ? "" : ` --run ${decision.runId}`;
    lines.push(`    Resume: paved ${command}${run} --answer ${decision.id}=<option> --answered-by <you>`);
  }
  return lines.join("\n");
}

export function renderDecisions(result: CommandResult): string {
  const decisions = result.decisions ?? [];
  if (decisions.length === 0) return "";
  const required = decisions.filter((item) => item.required).length;
  const heading = required > 0
    ? `Paved needs ${required} decision${required === 1 ? "" : "s"} before continuing:`
    : "Paved has optional proposals for you:";
  return [heading, "", ...decisions.map((item) => renderDecision(item, result.command))].join("\n");
}
```

In `renderHuman`, append `renderDecisions(result)` to the rendered output when it is non-empty, after the existing status/diagnostics sections.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cli/decisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/output.ts tests/cli/decisions.test.ts
git commit -m "feat: render pending decisions in human CLI output"
```

---

### Task 9: `--answer` and `--answered-by` flags

**Files:**
- Modify: `cli/runtime.ts`
- Test: `tests/cli/decisions.test.ts` (extend)

**Interfaces:**
- Consumes: `parseAnswerFlags` (Task 4).
- Produces: `CliFlags` gains `readonly answers: readonly string[]` and `readonly answeredBy?: string`. Both flags are accepted by every command. `--answer` without `--answered-by` is a usage error at parse time.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/decisions.test.ts`:

```ts
import { dispatchCli } from "../../cli/runtime.ts";

describe("answer flags", () => {
  it("rejects --answer without --answered-by", async () => {
    const result = await dispatchCli({ argv: ["verify", "--answer", "d-0123456789abcdef0123=all"] });
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics[0]?.category, "usage");
    assert.match(result.diagnostics[0]?.message ?? "", /--answered-by/);
  });

  it("rejects a reserved --answered-by identity", async () => {
    const result = await dispatchCli({
      argv: ["verify", "--answer", "d-0123456789abcdef0123=all", "--answered-by", "agent"],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics[0]?.category, "usage");
  });

  it("rejects a malformed --answer pair", async () => {
    const result = await dispatchCli({
      argv: ["verify", "--answer", "nonsense", "--answered-by", "anderson@example.com"],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostics[0]?.category, "usage");
  });

  it("passes parsed answers to the handler", async () => {
    let seen: readonly string[] = [];
    await dispatchCli({
      argv: ["verify", "--answer", "d-0123456789abcdef0123=all", "--answered-by", "anderson@example.com"],
      handlers: {
        verify: (invocation) => {
          seen = invocation.flags.answers;
          assert.equal(invocation.flags.answeredBy, "anderson@example.com");
          return createResult({ command: "verify", status: "success" });
        },
      },
    });
    assert.deepEqual(seen, ["d-0123456789abcdef0123=all"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/decisions.test.ts`
Expected: FAIL — `--answer` is reported as an unknown flag.

- [ ] **Step 3: Modify `cli/runtime.ts`**

Extend `CliFlags`:

```ts
export interface CliFlags {
  readonly adapters: readonly string[];
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly noGenerate: boolean;
  readonly inputs?: string;
  readonly run?: string;
  readonly advance?: boolean;
  readonly note?: string;
  readonly evidence?: string;
  readonly project?: string;
  readonly answers: readonly string[];
  readonly answeredBy?: string;
}
```

In `parse`, declare `const answers: string[] = []; let answeredBy: string | undefined;` and add
a branch before the generic `token.startsWith("-")` rejection:

```ts
    if (token === "--answer" || token === "--answered-by") {
      const value = takeValue(argv, index, token, command ?? "cli");
      if (typeof value !== "string") return { kind: "error", result: value };
      if (token === "--answer") answers.push(value);
      else answeredBy = value;
      index += 1;
      continue;
    }
```

After the loop, before building `flags`, validate the pair:

```ts
  if (answers.length > 0) {
    const parsed = parseAnswerFlags(answers);
    if ("problems" in parsed) {
      return { kind: "error", result: usage(command, parsed.problems.join(" ")) };
    }
    try {
      assertAnswerIdentity(answeredBy);
    } catch (error) {
      return {
        kind: "error",
        result: usage(command, error instanceof Error ? error.message : "Invalid --answered-by."),
      };
    }
  }
```

Import both helpers from `./lib/decisions/answers.ts`. Include the two fields in the
returned `flags` object, following the existing optional-property idiom:

```ts
  const flags = {
    adapters, dryRun, json, noGenerate, advance, answers,
    ...(answeredBy === undefined ? {} : { answeredBy }),
    ...(run === undefined ? {} : { run }),
    // ...remaining existing spreads unchanged
  };
```

Also add the flags to `commandUsage`'s global options block:

```
  "  --answer <id>=<value>    Answer a pending Paved decision; repeatable.",
  "  --answered-by <identity> The person who decided; required with --answer.",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cli/decisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the CLI suite for regressions**

Run: `node --test tests/cli/cli.test.ts tests/cli/commands.test.ts`
Expected: PASS. Any test asserting the exact `--help` text needs the two new lines.

- [ ] **Step 6: Commit**

```bash
git add cli/runtime.ts tests/cli/decisions.test.ts
git commit -m "feat: accept --answer and --answered-by on every command"
```

---

### Task 10: The human-authored approval channel

**Files:**
- Create: `cli/lib/decisions/approval.ts`
- Test: `tests/decisions/security.test.ts` (extend)

**Interfaces:**
- Consumes: `Decision` (Task 2).
- Produces:
  - `decisionDigest(decision: Decision): string` — sha256 over question, options and evidence only
  - `readDecisionApproval(projectRoot: string, decision: Decision): { answer: unknown; decided_by: string; decided_at: string } | undefined` — throws `ApprovalError` when present but invalid
  - `class ApprovalError extends Error`

- [ ] **Step 1: Write the failing test**

Append to `tests/decisions/security.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { ApprovalError, decisionDigest, readDecisionApproval } from "../../cli/lib/decisions/approval.ts";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const approvalWorkspaces: string[] = [];
after(() => { for (const path of approvalWorkspaces) rmSync(path, { recursive: true, force: true }); });

function approvalWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), "paved-approval-"));
  approvalWorkspaces.push(path);
  mkdirSync(join(path, ".paved/approvals"), { recursive: true });
  return path;
}

function irreversible(): Decision {
  const evidence = [{ type: "file" as const, location: "src/App.java", sha256: "a".repeat(64) }];
  return {
    apiVersion: "paved/v1", kind: "Decision", id: "d-0123456789abcdef0123",
    scope: "project", command: "doctor", category: "material", authored_by: "runtime",
    question: "Apply this repair?", reason: "Generated context no longer matches its sources.",
    options: [{ id: "apply", label: "Apply", description: "d", consequence: "c" }],
    evidence, required: true, required_answer: { type: "single-choice" },
    risk: "high", reversibility: "irreversible", answer_channel: "human-authored",
    status: "ASKED", fingerprint: fingerprintOf(evidence, ["apply"]),
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

function writeApproval(project: string, decision: Decision, body: Record<string, unknown>): void {
  writeFileSync(join(project, `.paved/approvals/${decision.id}.json`), JSON.stringify(body));
}

describe("human-authored approval channel", () => {
  it("accepts a well-formed approval", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.equal(readDecisionApproval(project, decision)?.decided_by, "anderson@example.com");
  });

  it("returns undefined when no approval exists", () => {
    assert.equal(readDecisionApproval(approvalWorkspace(), irreversible()), undefined);
  });

  it("rejects self-approval by the agent", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "agent", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("rejects an approval bound to different decision content", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: "b".repeat(64), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("rejects an approval naming a different decision", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: "d-ffffffffffffffffffff", decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("rejects an approval for a decision that is not ASKED", () => {
    const project = approvalWorkspace();
    const decision = { ...irreversible(), status: "PENDING" as const };
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("changes the digest when the question or options change, invalidating stale approvals", () => {
    const decision = irreversible();
    const reworded = { ...decision, question: "Apply this different repair?" };
    assert.notEqual(decisionDigest(decision), decisionDigest(reworded));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/security.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/approval.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveSafePath } from "../safe-path.ts";
import type { Decision } from "./record.ts";

export class ApprovalError extends Error {}

const DECISION_ID = /^d-[a-f0-9]{20}$/;
const RESERVED_IDENTITIES = new Set(["agent", "paved", "ci"]);

export interface DecisionApproval {
  readonly answer: unknown;
  readonly decided_by: string;
  readonly decided_at: string;
}

/**
 * Digests exactly what the human approved: the question, the options and the evidence.
 * Status and answer fields are excluded so the digest is stable across the lifecycle,
 * but any change to what was asked invalidates the approval (spec 6.2).
 */
export function decisionDigest(decision: Decision): string {
  return createHash("sha256").update(JSON.stringify({
    id: decision.id,
    question: decision.question,
    options: decision.options,
    evidence: decision.evidence,
  })).digest("hex");
}

export function readDecisionApproval(projectRoot: string, decision: Decision): DecisionApproval | undefined {
  if (!DECISION_ID.test(decision.id)) throw new ApprovalError(`Invalid decision id: ${decision.id}`);
  const path = resolveSafePath(projectRoot, `.paved/approvals/${decision.id}.json`);
  if (!existsSync(path)) return undefined;

  if (decision.status !== "ASKED") {
    throw new ApprovalError(`Approval exists for decision ${decision.id}, which is ${decision.status}, not ASKED.`);
  }

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new ApprovalError(`Approval record for ${decision.id} is not valid JSON.`);
  }

  const decidedBy = document.decided_by;
  const decidedAt = document.decided_at;
  if (document.decision !== decision.id
    || document.decision_sha256 !== decisionDigest(decision)
    || typeof decidedBy !== "string" || decidedBy.trim() === "" || RESERVED_IDENTITIES.has(decidedBy)
    || typeof decidedAt !== "string" || Number.isNaN(Date.parse(decidedAt))) {
    throw new ApprovalError(
      `Approval record for ${decision.id} is invalid or does not match the current decision. `
      + `A person must decide this exact decision in .paved/approvals/${decision.id}.json.`,
    );
  }

  return { answer: document.answer, decided_by: decidedBy, decided_at: decidedAt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/security.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/approval.ts tests/decisions/security.test.ts
git commit -m "feat: add human-authored approval channel for irreversible decisions"
```

---

### Task 11: The shared decision gate pipeline

**Files:**
- Create: `cli/lib/decisions/gate.ts`
- Test: `tests/decisions/batching.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6 and 10.
- Produces:
  - `interface DecisionContext { projectRoot; coreRoot; command; run?; answers; answeredBy? }`
  - `interface DecisionCandidate { question; reason; options; recommended?; evidence; required; requiredAnswer; effect; handler; candidates; dependsOn?; planApproval?; scope }`
  - `type DecisionProvider = (context: DecisionContext) => readonly DecisionCandidate[]`
  - `interface HandlerRegistration { effect: EffectClass; apply: (answer: AnswerValue, context: DecisionContext) => readonly string[] }`
  - `interface DecisionGateOutcome { status: "continue" | "awaiting-input"; projections: DecisionProjection[]; applied: Decision[]; problems: string[] }`
  - `runDecisionGate(input: { context; providers; handlers; persist: boolean }): DecisionGateOutcome`
  - `toProjection(decision: Decision): DecisionProjection`

Providers and handlers are passed explicitly rather than held in a module-level registry, so each command composes its own set and tests need no global reset.

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/batching.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decisionId } from "../../cli/lib/decisions/record.ts";
import { runDecisionGate, type DecisionCandidate, type DecisionContext, type HandlerRegistration } from "../../cli/lib/decisions/gate.ts";

const coreRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspaces: string[] = [];
after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "paved-gate-"));
  workspaces.push(path);
  return path;
}

const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];

function candidate(over: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    scope: "project",
    question: "Adopt the detected checks?",
    reason: "They already run in CI but are not Paved gates.",
    options: [
      { id: "all", label: "All", description: "Adopt all.", consequence: "All become gates." },
      { id: "none", label: "None", description: "Adopt none.", consequence: "No profile is written." },
    ],
    evidence,
    required: true,
    requiredAnswer: { type: "single-choice" },
    effect: "config-additive",
    handler: "verification.adopt",
    candidates: ["mvn-validate", "mvn-test"],
    ...over,
  };
}

function context(project: string, over: Partial<DecisionContext> = {}): DecisionContext {
  return { projectRoot: project, coreRoot, command: "verify", answers: [], ...over };
}

describe("decision gate", () => {
  it("raises a material decision and reports awaiting-input", () => {
    const project = workspace();
    const outcome = runDecisionGate({
      context: context(project),
      providers: [() => [candidate()]],
      handlers: new Map(),
      persist: true,
    });
    assert.equal(outcome.status, "awaiting-input");
    assert.equal(outcome.projections.length, 1);
    assert.equal(outcome.projections[0]?.answerChannel, "relayed");
  });

  it("derives risk, reversibility and channel from the effect class, ignoring any caller claim", () => {
    const project = workspace();
    const outcome = runDecisionGate({
      context: context(project),
      providers: [() => [candidate({ effect: "destructive" })]],
      handlers: new Map(),
      persist: true,
    });
    assert.equal(outcome.projections[0]?.reversibility, "irreversible");
    assert.equal(outcome.projections[0]?.answerChannel, "human-authored");
  });

  it("is idempotent — re-running produces the same decision id and no duplicate", () => {
    const project = workspace();
    const run = () => runDecisionGate({
      context: context(project), providers: [() => [candidate()]],
      handlers: new Map(), persist: true,
    });
    const first = run();
    const second = run();
    assert.equal(first.projections[0]?.id, second.projections[0]?.id);
    assert.equal(second.projections.length, 1);
  });

  it("batches independent decisions into one awaiting-input", () => {
    const project = workspace();
    const outcome = runDecisionGate({
      context: context(project),
      providers: [() => [
        candidate({ question: "Adopt checks?", candidates: ["a"] }),
        candidate({ question: "Adopt the Checkstyle rule?", candidates: ["b"], handler: "rules.adopt" }),
      ]],
      handlers: new Map(), persist: true,
    });
    assert.equal(outcome.projections.length, 2);
  });

  it("holds a dependent decision at PENDING until its dependency resolves", () => {
    const project = workspace();
    const firstId = decisionId("Adopt checks?", "project:verify", ["a"]);
    const outcome = runDecisionGate({
      context: context(project),
      providers: [() => [
        candidate({ question: "Adopt checks?", candidates: ["a"] }),
        candidate({ question: "Which scope?", candidates: ["b"], dependsOn: [firstId] }),
      ]],
      handlers: new Map(), persist: true,
    });
    assert.equal(outcome.projections.length, 1, "the dependent decision must not be emitted yet");
    assert.equal(outcome.projections[0]?.question, "Adopt checks?");
  });

  it("applies an answer and continues", () => {
    const project = workspace();
    const id = decisionId("Adopt the detected checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    const handlers = new Map<string, HandlerRegistration>([
      ["verification.adopt", { effect: "config-additive", apply: () => [".paved/verification/profile.yaml"] }],
    ]);
    runDecisionGate({ context: context(project), providers: [() => [candidate()]], handlers, persist: true });
    const outcome = runDecisionGate({
      context: context(project, { answers: [`${id}=all`], answeredBy: "anderson@example.com" }),
      providers: [() => [candidate()]], handlers, persist: true,
    });
    assert.equal(outcome.status, "continue");
    assert.equal(outcome.applied[0]?.status, "APPLIED");
    assert.deepEqual(outcome.applied[0]?.applied_changes, [".paved/verification/profile.yaml"]);
  });

  it("does not re-ask an applied decision", () => {
    const project = workspace();
    const id = decisionId("Adopt the detected checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    const handlers = new Map<string, HandlerRegistration>([
      ["verification.adopt", { effect: "config-additive", apply: () => [".paved/verification/profile.yaml"] }],
    ]);
    runDecisionGate({ context: context(project), providers: [() => [candidate()]], handlers, persist: true });
    runDecisionGate({
      context: context(project, { answers: [`${id}=all`], answeredBy: "anderson@example.com" }),
      providers: [() => [candidate()]], handlers, persist: true,
    });
    const third = runDecisionGate({
      context: context(project), providers: [() => [candidate()]], handlers, persist: true,
    });
    assert.equal(third.status, "continue");
    assert.equal(third.projections.length, 0);
  });

  it("reports an invalid answer as a problem and leaves the decision ASKED", () => {
    const project = workspace();
    const id = decisionId("Adopt the detected checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    runDecisionGate({ context: context(project), providers: [() => [candidate()]], handlers: new Map(), persist: true });
    const outcome = runDecisionGate({
      context: context(project, { answers: [`${id}=invented`], answeredBy: "anderson@example.com" }),
      providers: [() => [candidate()]], handlers: new Map(), persist: true,
    });
    assert.ok(outcome.problems.length > 0);
    assert.equal(outcome.status, "awaiting-input");
  });

  it("supersedes an applied decision when its cited evidence changes", () => {
    const project = workspace();
    const id = decisionId("Adopt the detected checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    const handlers = new Map<string, HandlerRegistration>([
      ["verification.adopt", { effect: "config-additive", apply: () => [] }],
    ]);
    runDecisionGate({ context: context(project), providers: [() => [candidate()]], handlers, persist: true });
    runDecisionGate({
      context: context(project, { answers: [`${id}=all`], answeredBy: "anderson@example.com" }),
      providers: [() => [candidate()]], handlers, persist: true,
    });
    const moved = [{ type: "file" as const, location: "pom.xml", sha256: "c".repeat(64) }];
    const outcome = runDecisionGate({
      context: context(project), providers: [() => [candidate({ evidence: moved })]],
      handlers, persist: true,
    });
    assert.equal(outcome.status, "awaiting-input", "changed evidence must re-raise the question");
  });

  it("does not persist when persist is false, but still projects", () => {
    const project = workspace();
    const outcome = runDecisionGate({
      context: context(project, { command: "doctor" }),
      providers: [() => [candidate({ required: false })]],
      handlers: new Map(), persist: false,
    });
    assert.equal(outcome.projections.length, 1);
    assert.equal(outcome.status, "continue", "optional decisions never block");
    assert.throws(() => rmSync(join(project, ".paved/decisions"), { recursive: true }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/batching.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/gate.ts`:

```ts
import type { DecisionProjection } from "../../result.ts";
import { acquireConsumerOperationLock } from "../operation-lock.ts";
import { validateAnswer, type AnswerValue } from "./answers.ts";
import { readDecisionApproval } from "./approval.ts";
import { tierFor, type EffectClass } from "./effects.ts";
import { fingerprintOf, isStale, supersede } from "./fingerprint.ts";
import {
  decisionId, transition,
  type Decision, type DecisionEvidence, type DecisionOption, type RequiredAnswer,
} from "./record.ts";
import { listDecisions, readDecision, writeDecision } from "./store.ts";

export interface DecisionContext {
  readonly projectRoot: string;
  readonly coreRoot: string;
  readonly command: string;
  readonly run?: string;
  readonly answers: readonly string[];
  readonly answeredBy?: string;
}

export interface DecisionCandidate {
  readonly scope: "project" | "run";
  readonly question: string;
  readonly reason: string;
  readonly options: readonly DecisionOption[];
  readonly recommended?: string;
  readonly evidence: readonly DecisionEvidence[];
  readonly required: boolean;
  readonly requiredAnswer: RequiredAnswer;
  readonly effect: EffectClass;
  /** Key into the handler map; the handler's registered effect class governs the channel. */
  readonly handler: string;
  /** The candidate set that, with the evidence, identifies and fingerprints this decision. */
  readonly candidates: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly planApproval?: boolean;
}

export type DecisionProvider = (context: DecisionContext) => readonly DecisionCandidate[];

export interface HandlerRegistration {
  readonly effect: EffectClass;
  readonly apply: (answer: AnswerValue, context: DecisionContext) => readonly string[];
}

export interface DecisionGateOutcome {
  readonly status: "continue" | "awaiting-input";
  readonly projections: DecisionProjection[];
  readonly applied: Decision[];
  readonly problems: string[];
}

const now = () => new Date().toISOString();

export function toProjection(decision: Decision): DecisionProjection {
  return {
    id: decision.id,
    question: decision.question,
    reason: decision.reason,
    options: decision.options,
    ...(decision.recommended_option === undefined ? {} : { recommended: decision.recommended_option }),
    evidence: decision.evidence,
    required: decision.required,
    risk: decision.risk,
    reversibility: decision.reversibility,
    answerChannel: decision.answer_channel,
    ...(decision.depends_on === undefined ? {} : { dependsOn: decision.depends_on }),
    ...(decision.run === undefined ? {} : { runId: decision.run }),
  };
}

function scopeKey(candidate: DecisionCandidate, context: DecisionContext): string {
  return candidate.scope === "run"
    ? `run:${context.run ?? ""}:${context.command}`
    : `project:${context.command}`;
}

function materialize(candidate: DecisionCandidate, context: DecisionContext): Decision {
  const tier = tierFor(candidate.effect, { planApproval: candidate.planApproval === true });
  const id = decisionId(candidate.question, scopeKey(candidate, context), candidate.candidates);
  return {
    apiVersion: "paved/v1",
    kind: "Decision",
    id,
    scope: candidate.scope,
    command: context.command,
    ...(candidate.scope === "run" && context.run !== undefined ? { run: context.run } : {}),
    category: "material",
    authored_by: "runtime",
    question: candidate.question,
    reason: candidate.reason,
    options: candidate.options,
    ...(candidate.recommended === undefined ? {} : { recommended_option: candidate.recommended }),
    evidence: candidate.evidence,
    required: candidate.required,
    required_answer: candidate.requiredAnswer,
    risk: tier.risk,
    reversibility: tier.reversibility,
    answer_channel: tier.channel,
    effect: candidate.effect,
    ...(candidate.dependsOn === undefined ? {} : { depends_on: candidate.dependsOn }),
    status: "PENDING",
    fingerprint: fingerprintOf(candidate.evidence, candidate.candidates),
    created_at: now(),
  };
}

const RESOLVED = new Set(["APPLIED", "REJECTED"]);

export function runDecisionGate(input: {
  readonly context: DecisionContext;
  readonly providers: readonly DecisionProvider[];
  readonly handlers: ReadonlyMap<string, HandlerRegistration>;
  readonly persist: boolean;
}): DecisionGateOutcome {
  const { context, providers, handlers, persist } = input;
  const problems: string[] = [];
  const applied: Decision[] = [];

  // 1. LOAD
  const stored = new Map(listDecisions(context.projectRoot).map((item) => [item.id, item]));

  // 5. DETECT (run first so current evidence is available for revalidation)
  const candidates = providers.flatMap((provider) => provider(context));
  const current = new Map<string, { candidate: DecisionCandidate; decision: Decision }>();
  for (const candidate of candidates) {
    const decision = materialize(candidate, context);
    current.set(decision.id, { candidate, decision });
  }

  const live = new Map<string, Decision>();
  for (const [id, { candidate, decision }] of current) {
    const existing = stored.get(id);
    if (existing === undefined) {
      live.set(id, decision);
      continue;
    }
    // 2. REVALIDATE — narrow fingerprint; a mismatch supersedes even an APPLIED decision.
    const fingerprint = fingerprintOf(candidate.evidence, candidate.candidates);
    if (isStale(existing, fingerprint)) {
      const successor = { ...decision, supersedes: existing.id };
      if (persist) {
        writeDecision(context.projectRoot, context.coreRoot,
          supersede(existing, "Cited evidence or candidate set changed.", successor.id));
      }
      live.set(id, successor);
      continue;
    }
    live.set(id, existing);
  }

  // 3. ANSWER
  const answers = new Map<string, string[]>();
  for (const entry of context.answers) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const id = entry.slice(0, separator);
    answers.set(id, [...(answers.get(id) ?? []), entry.slice(separator + 1)]);
  }

  const release = answers.size > 0 && persist
    ? acquireConsumerOperationLock(context.projectRoot, `decision:${context.command}`)
    : undefined;
  try {
    for (const [id, values] of answers) {
      const decision = live.get(id) ?? stored.get(id) ?? readDecision(context.projectRoot, id);
      if (decision === undefined) {
        problems.push(`Unknown decision: ${id}.`);
        continue;
      }
      // Replay: the same value is an idempotent no-op; a different value must go through revise.
      if (RESOLVED.has(decision.status)) {
        const validated = validateAnswer(decision, values);
        if ("problems" in validated) { problems.push(...validated.problems); continue; }
        if (JSON.stringify(validated.value) !== JSON.stringify(decision.answer)) {
          problems.push(`Decision ${id} is already ${decision.status}. Use paved decision revise ${id}.`);
        }
        continue;
      }

      const asked = decision.status === "PENDING"
        ? transition(decision, "ASKED", { asked_at: now() })
        : decision;
      const validated = validateAnswer(asked, values);
      if ("problems" in validated) {
        problems.push(...validated.problems);
        live.set(id, asked);
        if (persist) writeDecision(context.projectRoot, context.coreRoot, asked);
        continue;
      }

      // Irreversible decisions require a human-authored approval file; a relayed answer
      // never satisfies them.
      let source: Decision["answer_source"] = "agent-relayed";
      let identity = context.answeredBy;
      if (asked.answer_channel === "human-authored") {
        const approval = readDecisionApproval(context.projectRoot, asked);
        if (approval === undefined) {
          problems.push(
            `Decision ${id} is irreversible. A person must author .paved/approvals/${id}.json.`,
          );
          live.set(id, asked);
          if (persist) writeDecision(context.projectRoot, context.coreRoot, asked);
          continue;
        }
        source = "human-authored";
        identity = approval.decided_by;
      }
      if (identity === undefined) { problems.push(`Decision ${id} has no answering identity.`); continue; }

      const answered = transition(asked, "ANSWERED", {
        answer: validated.value, answered_by: identity, answer_source: source, answered_at: now(),
      });
      if (persist) writeDecision(context.projectRoot, context.coreRoot, answered);
      live.set(id, answered);
    }

    // 4. MATERIALIZE — ANSWERED is durable before the mutation; APPLIED after. A crash in
    // between re-applies on the next run, which is why handlers must be idempotent.
    for (const [id, decision] of live) {
      if (decision.status !== "ANSWERED") continue;
      const registration = decision.effect === undefined ? undefined : handlers.get(
        current.get(id)?.candidate.handler ?? "");
      if (registration === undefined) continue;
      const changes = registration.apply(decision.answer as AnswerValue, context);
      const done = transition(decision, "APPLIED", {
        applied_changes: changes, applied_at: now(),
      });
      if (persist) writeDecision(context.projectRoot, context.coreRoot, done);
      live.set(id, done);
      applied.push(done);
    }
  } finally {
    release?.();
  }

  // 6. SEQUENCE — a decision whose dependencies are unresolved is never emitted.
  const resolvedIds = new Set([...live.values()].filter((item) => RESOLVED.has(item.status)).map((item) => item.id));
  const emitted: Decision[] = [];
  for (const [id, decision] of live) {
    if (RESOLVED.has(decision.status) || decision.status === "SUPERSEDED" || decision.status === "CANCELLED") continue;
    if ((decision.depends_on ?? []).some((dependency) => !resolvedIds.has(dependency))) continue;
    const asked = decision.status === "PENDING"
      ? transition(decision, "ASKED", { asked_at: now() })
      : decision;
    if (persist) writeDecision(context.projectRoot, context.coreRoot, asked);
    live.set(id, asked);
    emitted.push(asked);
  }

  // 7. VERDICT
  const blocking = emitted.some((decision) => decision.required);
  return {
    status: blocking ? "awaiting-input" : "continue",
    projections: emitted.map(toProjection),
    applied,
    problems,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/batching.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/decisions/gate.ts tests/decisions/batching.test.ts
git commit -m "feat: add the shared decision gate pipeline"
```

---

### Task 12: The `decision` command

**Files:**
- Create: `cli/commands/decision.ts`
- Modify: `cli/runtime.ts` (add `decision` to `COMMAND_NAMES`, `COMMAND_RULES`, `DEFAULT_HANDLERS`; accept `--decision <json>`)
- Test: `tests/cli/decisions.test.ts` (extend)

**Interfaces:**
- Consumes: store (Task 6), record (Task 2), effects (Task 5).
- Produces: `decisionHandler(invocation: CommandInvocation): CommandResult` supporting `raise`, `list`, `show`, `revise`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/decisions.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const commandWorkspaces: string[] = [];
after(() => { for (const path of commandWorkspaces) rmSync(path, { recursive: true, force: true }); });
function commandWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), "paved-decision-cmd-"));
  commandWorkspaces.push(path);
  return path;
}

const agentDecision = (over: Record<string, unknown> = {}) => JSON.stringify({
  question: "Which identity provider should SSO use?",
  reason: "Repository evidence does not determine the intended product behaviour.",
  options: [
    { id: "keycloak", label: "Keycloak", description: "Self-hosted.", consequence: "Adds a Keycloak dependency." },
    { id: "auth0", label: "Auth0", description: "Hosted.", consequence: "Adds an external dependency." },
  ],
  evidence: [{ type: "file", location: "README.md", sha256: "a".repeat(64) }],
  required: true,
  requiredAnswer: { type: "single-choice" },
  effect: "record-only",
  candidates: ["keycloak", "auth0"],
  ...over,
});

describe("decision command", () => {
  it("raises an agent-authored decision", async () => {
    const project = commandWorkspace();
    const result = await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision(), "--project", project],
    });
    assert.equal(result.status, "success");
    assert.match(String((result.data as { id?: string }).id), /^d-[a-f0-9]{20}$/);
  });

  it("stamps agent-raised decisions as authored_by agent", async () => {
    const project = commandWorkspace();
    await dispatchCli({ argv: ["decision", "raise", "--decision", agentDecision(), "--project", project] });
    const list = await dispatchCli({ argv: ["decision", "list", "--project", project] });
    const decisions = (list.data as { decisions: { authoredBy: string }[] }).decisions;
    assert.equal(decisions[0]?.authoredBy, "agent");
  });

  it("rejects an agent decision claiming runtime authorship", async () => {
    const project = commandWorkspace();
    const result = await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision({ authored_by: "runtime" }), "--project", project],
    });
    assert.equal(result.status, "failed");
  });

  it("rejects an agent decision claiming the deterministic category", async () => {
    const project = commandWorkspace();
    const result = await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision({ category: "deterministic" }), "--project", project],
    });
    assert.equal(result.status, "failed");
  });

  it("rejects an agent decision referencing an irreversible effect class", async () => {
    const project = commandWorkspace();
    const result = await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision({ effect: "destructive" }), "--project", project],
    });
    assert.equal(result.status, "failed");
    assert.match(result.diagnostics[0]?.message ?? "", /effect/i);
  });

  it("rejects an agent decision with empty reason or evidence", async () => {
    const project = commandWorkspace();
    assert.equal((await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision({ reason: "" }), "--project", project],
    })).status, "failed");
    assert.equal((await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision({ evidence: [] }), "--project", project],
    })).status, "failed");
  });

  it("shows a stored decision", async () => {
    const project = commandWorkspace();
    const raised = await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision(), "--project", project],
    });
    const id = (raised.data as { id: string }).id;
    const shown = await dispatchCli({ argv: ["decision", "show", id, "--project", project] });
    assert.equal(shown.status, "success");
    assert.equal((shown.data as { decision: { id: string } }).decision.id, id);
  });

  it("revises a decision into SUPERSEDED", async () => {
    const project = commandWorkspace();
    const raised = await dispatchCli({
      argv: ["decision", "raise", "--decision", agentDecision(), "--project", project],
    });
    const id = (raised.data as { id: string }).id;
    const revised = await dispatchCli({
      argv: ["decision", "revise", id, "--reason", "Requirements changed.", "--project", project],
    });
    assert.equal(revised.status, "success");
    const shown = await dispatchCli({ argv: ["decision", "show", id, "--project", project] });
    assert.equal((shown.data as { decision: { status: string } }).decision.status, "SUPERSEDED");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/decisions.test.ts`
Expected: FAIL — `Unknown command: decision`.

- [ ] **Step 3: Write the command**

Create `cli/commands/decision.ts`:

```ts
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { AGENT_ASSIGNABLE_EFFECTS, tierFor, type EffectClass } from "../lib/decisions/effects.ts";
import { fingerprintOf } from "../lib/decisions/fingerprint.ts";
import { toProjection } from "../lib/decisions/gate.ts";
import { decisionId, supersedeReasonRequired, transition, type Decision } from "../lib/decisions/record.ts";
import { listDecisions, readDecision, writeDecision } from "../lib/decisions/store.ts";

function fail(code: string, message: string, remediation: string): CommandResult {
  return createResult({
    command: "decision",
    status: "failed",
    diagnostics: [createDiagnostic({
      severity: "error", category: "usage", code, component: "cli.commands.decision",
      message, remediation,
    })],
  });
}

interface RaiseInput {
  question?: unknown; reason?: unknown; options?: unknown; evidence?: unknown;
  required?: unknown; requiredAnswer?: unknown; effect?: unknown; candidates?: unknown;
  dependsOn?: unknown; authored_by?: unknown; category?: unknown; run?: unknown;
}

function raise(invocation: CommandInvocation, raw: string): CommandResult {
  let input: RaiseInput;
  try { input = JSON.parse(raw) as RaiseInput; }
  catch { return fail("PAVED_DECISION_INVALID_JSON", "--decision is not valid JSON.", "Pass a JSON object matching the Decision raise contract."); }

  // An agent may ask questions; it may not claim runtime authorship, declare a
  // deterministic decision, or select a channel with weaker guarantees.
  if (input.authored_by !== undefined && input.authored_by !== "agent") {
    return fail("PAVED_DECISION_AUTHOR_INVALID", "An agent-raised decision cannot claim runtime authorship.", "Omit authored_by.");
  }
  if (input.category !== undefined && input.category !== "material") {
    return fail("PAVED_DECISION_CATEGORY_INVALID", "An agent-raised decision is always material.", "Omit category.");
  }
  const effect = (input.effect ?? "record-only") as EffectClass;
  if (!AGENT_ASSIGNABLE_EFFECTS.has(effect)) {
    return fail("PAVED_DECISION_EFFECT_FORBIDDEN", `An agent-raised decision cannot use the ${effect} effect class.`, `Use one of: ${[...AGENT_ASSIGNABLE_EFFECTS].join(", ")}.`);
  }
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    return fail("PAVED_DECISION_REASON_REQUIRED", "An agent-raised decision must explain why it matters.", "Supply a non-empty reason.");
  }
  const evidence = Array.isArray(input.evidence) ? input.evidence as Decision["evidence"] : [];
  if (evidence.length === 0) {
    return fail("PAVED_DECISION_EVIDENCE_REQUIRED", "An agent-raised decision must cite evidence.", "Supply at least one evidence entry.");
  }

  const question = String(input.question ?? "");
  const candidates = (Array.isArray(input.candidates) ? input.candidates : []).map(String);
  const run = typeof input.run === "string" ? input.run : undefined;
  const scope = run === undefined ? "project" : "run";
  const scopeKey = run === undefined ? `project:${invocation.command}` : `run:${run}:${invocation.command}`;
  const tier = tierFor(effect);
  const decision: Decision = {
    apiVersion: "paved/v1", kind: "Decision",
    id: decisionId(question, scopeKey, candidates),
    scope, command: invocation.command,
    ...(run === undefined ? {} : { run }),
    category: "material", authored_by: "agent",
    question, reason: input.reason,
    options: input.options as Decision["options"],
    evidence, required: input.required !== false,
    required_answer: input.requiredAnswer as Decision["required_answer"],
    risk: tier.risk, reversibility: tier.reversibility, answer_channel: tier.channel,
    effect,
    ...(Array.isArray(input.dependsOn) ? { depends_on: input.dependsOn.map(String) } : {}),
    status: "PENDING", fingerprint: fingerprintOf(evidence, candidates),
    created_at: new Date().toISOString(),
  };

  try {
    writeDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, decision);
  } catch (error) {
    return fail("PAVED_DECISION_INVALID", error instanceof Error ? error.message : "Decision is invalid.", "Correct the decision payload and retry.");
  }
  return createResult({ command: "decision", status: "success", data: { id: decision.id } });
}

export function decisionHandler(invocation: CommandInvocation): CommandResult {
  const [operation = "list", target] = invocation.selectors;

  if (operation === "raise") {
    const raw = invocation.flags.decision;
    if (raw === undefined) return fail("PAVED_DECISION_USAGE", "raise requires --decision <json>.", "Pass the decision as a JSON object.");
    return raise(invocation, raw);
  }

  if (operation === "list") {
    const decisions = listDecisions(invocation.paths.projectRoot);
    return createResult({
      command: "decision", status: "success",
      data: {
        decisions: decisions.map((decision) => ({
          ...toProjection(decision),
          status: decision.status,
          authoredBy: decision.authored_by,
        })),
      },
    });
  }

  if (operation === "show") {
    if (target === undefined) return fail("PAVED_DECISION_USAGE", "show requires a decision id.", "Use paved decision show <id>.");
    const decision = readDecision(invocation.paths.projectRoot, target);
    if (decision === undefined) return fail("PAVED_DECISION_UNKNOWN", `Unknown decision: ${target}.`, "Run paved decision list --json.");
    return createResult({ command: "decision", status: "success", data: { decision } });
  }

  if (operation === "revise") {
    if (target === undefined) return fail("PAVED_DECISION_USAGE", "revise requires a decision id.", "Use paved decision revise <id> --reason <text>.");
    const reason = invocation.flags.note?.trim();
    if (!reason) return fail("PAVED_DECISION_REASON_REQUIRED", "revise requires --reason.", "Explain why the decision is being revised.");
    const decision = readDecision(invocation.paths.projectRoot, target);
    if (decision === undefined) return fail("PAVED_DECISION_UNKNOWN", `Unknown decision: ${target}.`, "Run paved decision list --json.");
    const revised = transition(decision, "SUPERSEDED", { superseded_reason: reason });
    writeDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, revised);
    return createResult({ command: "decision", status: "success", data: { id: revised.id, status: revised.status } });
  }

  return fail("PAVED_DECISION_USAGE", `Unknown decision operation: ${operation}.`, "Use raise, list, show or revise.");
}
```

Remove the unused `supersedeReasonRequired` import — it does not exist; the import line above is `import { decisionId, transition, type Decision } from "../lib/decisions/record.ts";`.

- [ ] **Step 4: Register the command in `cli/runtime.ts`**

- Add `"decision"` to `COMMAND_NAMES`.
- Add to `COMMAND_RULES`: `decision: { adapters: false, dryRun: false, noGenerate: false, selectors: true },`
- Add to `DEFAULT_HANDLERS`: `decision: decisionHandler,` with the matching import.
- Add `readonly decision?: string;` to `CliFlags`.
- Accept `--decision <json>`, restricted to the `decision` command, mirroring the `--inputs` branch:

```ts
    if (token === "--decision") {
      if (command !== "decision") {
        return { kind: "error", result: usage(command ?? "cli", "Flag --decision is supported only by the decision command.") };
      }
      const value = takeValue(argv, index, token, command);
      if (typeof value !== "string") return { kind: "error", result: value };
      decision = value;
      index += 1;
      continue;
    }
```

- Allow `--note` for `decision` by adding `"decision"` to the command list guarding `--note` in the `["--run", "--note", "--evidence"]` branch.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/cli/decisions.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the agent-contract suite**

Run: `node --test tests/agent-contract/synthetic-agent.test.ts`
Expected: PASS. `decision` is a CLI-only command and is deliberately **not** added to `AGENT_COMMANDS`; if the suite asserts that `COMMAND_NAMES` and `AGENT_COMMANDS` match one-for-one, relax it to allow CLI-only commands.

- [ ] **Step 7: Commit**

```bash
git add cli/commands/decision.ts cli/runtime.ts tests/cli/decisions.test.ts
git commit -m "feat: add the decision command for agent-authored questions"
```

---

### Task 13: `WorkflowRun` learns decisions and `awaiting-input`

**Files:**
- Modify: `schemas/workflow-run.schema.yaml`
- Modify: `cli/lib/workflows.ts` (`WorkflowRunRecord`, `assessRun`)
- Test: `tests/workflows/workflows.test.ts` (extend)

**Interfaces:**
- Consumes: the `Decision` schema (Task 1).
- Produces: `WorkflowRunRecord` gains `decisions?: { id: string; status: string; required: boolean }[]`; `assessRun` gains two cross-field rules.

- [ ] **Step 1: Write the failing test**

Append to `tests/workflows/workflows.test.ts`:

```ts
describe("workflow run decisions", () => {
  const workflow = {
    id: "core.feature", version: "1.0.0", status: "active", description: "Use when …",
    change_type: "feature", inputs: [{ id: "request", required: true }],
    phases: [{ phase: "context", goal: "g" }],
    evidence: { required: [] }, outputs: [], completion: { criteria: [] },
  } as never;

  const baseRun = {
    workflow: { id: "core.feature", version: "1.0.0" },
    status: "running",
    inputs: [{ id: "request" }],
    phases: [{ phase: "context", status: "running" }],
  };

  it("allows awaiting-input when a decision is ASKED", () => {
    const run = {
      ...baseRun, status: "awaiting-input",
      decisions: [{ id: "d-0123456789abcdef0123", status: "ASKED", required: true }],
    } as never;
    assert.deepEqual(assessRun(run, workflow), []);
  });

  it("rejects awaiting-input with no ASKED decision", () => {
    const run = {
      ...baseRun, status: "awaiting-input",
      decisions: [{ id: "d-0123456789abcdef0123", status: "APPLIED", required: true }],
    } as never;
    assert.ok(assessRun(run, workflow).some((problem) => /awaiting input/i.test(problem)));
  });

  it("rejects running while a required decision is unanswered", () => {
    const run = {
      ...baseRun, status: "running",
      decisions: [{ id: "d-0123456789abcdef0123", status: "ASKED", required: true }],
    } as never;
    assert.ok(assessRun(run, workflow).some((problem) => /unanswered required decision/i.test(problem)));
  });

  it("allows running while only an optional decision is open", () => {
    const run = {
      ...baseRun, status: "running",
      decisions: [{ id: "d-0123456789abcdef0123", status: "ASKED", required: false }],
    } as never;
    assert.deepEqual(assessRun(run, workflow), []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/workflows/workflows.test.ts`
Expected: FAIL — `assessRun` does not know about decisions.

- [ ] **Step 3: Update the schema**

In `schemas/workflow-run.schema.yaml`:

- Add `awaiting-input` to the `status` enum and document it:
  `` `awaiting-input`: a required decision is waiting for the project owner. ``
- Add the property:

```yaml
  decisions:
    description: >
      Decisions raised inside this run, in the order they were raised. Run-scoped
      decisions live here rather than in .paved/decisions/, because a question only has
      meaning inside the run that asked it.
    type: array
    items: { $ref: "urn:paved:schema:decision:v1" }
```

- Extend the `events[].type` enum with `decision-raised`, `decision-asked`,
  `decision-answered`, `decision-applied`, `decision-superseded`.
- Add to the top-level `allOf`:

```yaml
  - if:
      properties: { status: { const: awaiting-input } }
      required: [status]
    then:
      required: [decisions]
```

- [ ] **Step 4: Update `cli/lib/workflows.ts`**

Extend the record interface:

```ts
export interface WorkflowRunRecord {
  workflow: { id: string; version: string };
  status: string;
  inputs: { id: string }[];
  phases: { /* unchanged */ }[];
  decisions?: { id: string; status: string; required: boolean }[];
  failure?: RunFailure;
}
```

In `assessRun`, after the existing awaiting-approval check, add:

```ts
  const decisions = run.decisions ?? [];
  const openRequired = decisions.filter((item) => item.required && item.status === "ASKED");
  if (run.status === "awaiting-input" && openRequired.length === 0) {
    problems.push("run is awaiting input but no required decision is ASKED");
  }
  if (run.status === "running" && openRequired.length > 0) {
    problems.push(`run is running with ${openRequired.length} unanswered required decision(s)`);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/workflows/workflows.test.ts tests/workflows/execution.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add schemas/workflow-run.schema.yaml cli/lib/workflows.ts tests/workflows/workflows.test.ts
git commit -m "feat: record run-scoped decisions in the workflow run"
```

---

### Task 14: Verification candidate provider

**Files:**
- Create: `cli/lib/decisions/providers/verification.ts`
- Test: `tests/decisions/providers.test.ts`

**Interfaces:**
- Consumes: `discoverSources` (`cli/lib/generator-runtime.ts`), `DecisionCandidate` (Task 11).
- Produces:
  - `interface CheckCandidate { id: string; label: string; command: string; scope: string; source: DecisionEvidence }`
  - `detectCheckCandidates(projectRoot: string): CheckCandidate[]`
  - `verificationProvider: DecisionProvider` — returns `[]` when a valid profile already exists or when no candidate is found

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/providers.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { detectCheckCandidates, verificationProvider } from "../../cli/lib/decisions/providers/verification.ts";

const coreRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspaces: string[] = [];
after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paved-provider-"));
  workspaces.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const context = (projectRoot: string) => ({
  projectRoot, coreRoot, command: "verify", answers: [] as readonly string[],
});

describe("verification candidate detection", () => {
  it("detects Maven lifecycle checks from a pom.xml", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const ids = detectCheckCandidates(project).map((item) => item.id);
    assert.ok(ids.includes("mvn-validate"));
    assert.ok(ids.includes("mvn-test"));
  });

  it("detects npm scripts that are actually declared", () => {
    const project = workspace({
      "package.json": JSON.stringify({ scripts: { build: "ng build", test: "ng test" } }),
    });
    const ids = detectCheckCandidates(project).map((item) => item.id);
    assert.ok(ids.includes("npm-build"));
    assert.ok(ids.includes("npm-test"));
  });

  it("does not invent an npm script that is not declared", () => {
    const project = workspace({ "package.json": JSON.stringify({ scripts: { build: "ng build" } }) });
    assert.equal(detectCheckCandidates(project).some((item) => item.id === "npm-test"), false);
  });

  it("scopes candidates to the directory that declared them", () => {
    const project = workspace({
      "backend/pom.xml": "<project><artifactId>api</artifactId></project>",
      "frontend/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
    });
    const candidates = detectCheckCandidates(project);
    assert.equal(candidates.find((item) => item.id === "mvn-test")?.scope, "backend");
    assert.equal(candidates.find((item) => item.id === "npm-test")?.scope, "frontend");
  });
});

describe("verification provider", () => {
  it("offers bundled options plus none", () => {
    const project = workspace({
      "backend/pom.xml": "<project><artifactId>api</artifactId></project>",
      "frontend/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
    });
    const [candidate] = verificationProvider(context(project));
    assert.ok(candidate);
    const ids = candidate.options.map((option) => option.id);
    assert.ok(ids.includes("all"));
    assert.ok(ids.includes("none"));
    assert.equal(candidate.required, true);
    assert.equal(candidate.effect, "config-additive");
  });

  it("recommends adopting everything, citing evidence", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const [candidate] = verificationProvider(context(project));
    assert.equal(candidate?.recommended, "all");
    assert.ok((candidate?.evidence.length ?? 0) > 0, "a recommendation must cite evidence");
  });

  it("raises nothing when a verification profile already exists", () => {
    const project = workspace({
      "pom.xml": "<project><artifactId>api</artifactId></project>",
      ".paved/verification/profile.yaml": "apiVersion: paved/v1\nkind: VerificationProfile\n",
    });
    assert.deepEqual(verificationProvider(context(project)), []);
  });

  it("raises nothing when the repository has no detectable check", () => {
    const project = workspace({ "README.md": "# nothing to verify\n" });
    assert.deepEqual(verificationProvider(context(project)), []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/providers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `cli/lib/decisions/providers/verification.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverSources } from "../../generator-runtime.ts";
import type { DecisionCandidate, DecisionProvider } from "../gate.ts";
import type { DecisionEvidence } from "../record.ts";

export interface CheckCandidate {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly scope: string;
  readonly source: DecisionEvidence;
}

// Only lifecycle phases that every Maven build defines. Nothing is inferred from a
// script the repository did not declare.
const MAVEN_CHECKS = [
  { id: "mvn-validate", label: "mvn validate", command: "validate" },
  { id: "mvn-test", label: "mvn test", command: "test" },
];

const NPM_CHECKS = [
  { id: "npm-build", label: "npm run build", script: "build" },
  { id: "npm-test", label: "npm test", script: "test" },
];

const scopeOf = (path: string) => (path.includes("/") ? dirname(path) : ".");

export function detectCheckCandidates(projectRoot: string): CheckCandidate[] {
  const candidates: CheckCandidate[] = [];
  for (const source of discoverSources(projectRoot)) {
    const evidence: DecisionEvidence = { type: "file", location: source.path, sha256: source.sha256 };
    const scope = scopeOf(source.path);

    if (source.path.endsWith("pom.xml")) {
      for (const check of MAVEN_CHECKS) {
        candidates.push({ ...check, scope, source });
      }
    }

    if (source.path.endsWith("package.json")) {
      let scripts: Record<string, unknown> = {};
      try {
        scripts = (JSON.parse(readFileSync(join(projectRoot, source.path), "utf8")) as {
          scripts?: Record<string, unknown>;
        }).scripts ?? {};
      } catch { continue; }
      for (const check of NPM_CHECKS) {
        if (typeof scripts[check.script] !== "string") continue;
        candidates.push({
          id: check.id, label: check.label, command: check.script, scope, source: evidence,
        });
      }
    }
  }
  return candidates
    .map((candidate) => ({ ...candidate, source: { type: "file" as const, location: candidate.source.location, sha256: candidate.source.sha256 } }))
    .sort((a, b) => `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`, "en"));
}

/**
 * Raises nothing when a profile already exists: valid existing configuration is read as
 * already decided, and Paved does not re-ask an answered question (spec 3.4).
 */
export const verificationProvider: DecisionProvider = (context): readonly DecisionCandidate[] => {
  if (existsSync(join(context.projectRoot, ".paved/verification/profile.yaml"))) return [];
  const candidates = detectCheckCandidates(context.projectRoot);
  if (candidates.length === 0) return [];

  const scopes = [...new Set(candidates.map((item) => item.scope))].sort((a, b) => a.localeCompare(b, "en"));
  const options = [
    {
      id: "all", label: "All detected checks",
      description: candidates.map((item) => item.label).join(", "),
      consequence: "Every detected check becomes a Paved verification gate.",
    },
    ...scopes.map((scope) => ({
      id: `scope-${scope === "." ? "root" : scope.replace(/\//g, "-")}`,
      label: scope === "." ? "Repository root only" : `${scope} only`,
      description: candidates.filter((item) => item.scope === scope).map((item) => item.label).join(", "),
      consequence: `Only the checks detected in ${scope === "." ? "the repository root" : scope} become gates.`,
    })),
    {
      id: "none", label: "None",
      description: "Adopt no checks now.",
      consequence: "No verification profile is created and verification stays unavailable.",
    },
  ];

  const evidence = [...new Map(candidates.map((item) => [item.source.location, item.source])).values()]
    .sort((a, b) => a.location.localeCompare(b.location, "en"));

  return [{
    scope: "project",
    question: "Should the detected repository checks become Paved verification gates?",
    reason:
      "These commands already exist in the repository, but Paved authorizes no check implicitly. "
      + "Adopting them lets verification prove a change before it completes.",
    options,
    recommended: "all",
    evidence,
    required: true,
    requiredAnswer: { type: "single-choice" },
    effect: "config-additive",
    handler: "verification.adopt",
    candidates: candidates.map((item) => `${item.scope}:${item.id}`),
  }];
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/decisions/providers.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/providers/verification.ts tests/decisions/providers.test.ts
git commit -m "feat: detect verification gate candidates from repository evidence"
```

---

### Task 15: Verification apply handler and the `verify` pilot

**Files:**
- Create: `cli/lib/decisions/handlers/verification.ts`
- Modify: `cli/commands/verify.ts`
- Test: `tests/decisions/providers.test.ts` (extend), `tests/verification/verification.test.ts` (extend)

**Interfaces:**
- Consumes: `CheckCandidate`, `detectCheckCandidates` (Task 14), gate (Task 11).
- Produces:
  - `verificationHandler: HandlerRegistration` registered under `"verification.adopt"`, effect `config-additive`
  - `verifyHandler` runs the gate before executing verification

- [ ] **Step 1: Write the failing test**

Append to `tests/decisions/providers.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { runDecisionGate } from "../../cli/lib/decisions/gate.ts";
import { verificationHandler } from "../../cli/lib/decisions/handlers/verification.ts";
import { decisionId } from "../../cli/lib/decisions/record.ts";

describe("verification apply handler", () => {
  function adopt(project: string, answer: string) {
    const handlers = new Map([["verification.adopt", verificationHandler]]);
    const providers = [verificationProvider];
    const first = runDecisionGate({ context: context(project), providers, handlers, persist: true });
    const id = first.projections[0]!.id;
    return runDecisionGate({
      context: { ...context(project), answers: [`${id}=${answer}`], answeredBy: "anderson@example.com" },
      providers, handlers, persist: true,
    });
  }

  it("writes a verification profile Paved can read back", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "all");
    assert.equal(outcome.status, "continue");
    const profile = parse(readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8")) as {
      kind: string; checks: { id: string }[];
    };
    assert.equal(profile.kind, "VerificationProfile");
    assert.ok(profile.checks.length > 0);
  });

  it("records the written path as the decision's applied change", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "all");
    assert.deepEqual(outcome.applied[0]?.applied_changes, [".paved/verification/profile.yaml"]);
  });

  it("is idempotent — applying twice produces the same file", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    adopt(project, "all");
    const first = readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8");
    verificationHandler.apply("all", context(project));
    assert.equal(readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8"), first);
  });

  it("writes no profile when the answer is none, and records the rejection", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "none");
    assert.equal(existsSync(join(project, ".paved/verification/profile.yaml")), false);
    assert.deepEqual(outcome.applied[0]?.applied_changes, []);
  });

  it("never marks verification as passed — it only writes the profile", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "all");
    assert.equal(existsSync(join(project, ".paved/generated/evidence")), false,
      "adopting checks must not produce verification evidence");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/providers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler**

Create `cli/lib/decisions/handlers/verification.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { resolveSafePath } from "../../safe-path.ts";
import type { AnswerValue } from "../answers.ts";
import type { DecisionContext, HandlerRegistration } from "../gate.ts";
import { detectCheckCandidates, type CheckCandidate } from "../providers/verification.ts";

const PROFILE_PATH = ".paved/verification/profile.yaml";

function selected(answer: AnswerValue, candidates: readonly CheckCandidate[]): CheckCandidate[] {
  if (answer === "none") return [];
  if (answer === "all") return [...candidates];
  const prefix = "scope-";
  if (typeof answer === "string" && answer.startsWith(prefix)) {
    const label = answer.slice(prefix.length);
    return candidates.filter((item) =>
      (item.scope === "." ? "root" : item.scope.replace(/\//g, "-")) === label);
  }
  return [];
}

/**
 * Writing the profile authorizes checks; it never asserts that they passed. Verification
 * still has to execute (spec 7.3).
 */
function apply(answer: AnswerValue, context: DecisionContext): readonly string[] {
  const candidates = detectCheckCandidates(context.projectRoot);
  const chosen = selected(answer, candidates);
  if (chosen.length === 0) return [];

  const profile = {
    apiVersion: "paved/v1",
    kind: "VerificationProfile",
    checks: chosen.map((candidate) => ({
      id: `project.detected.${candidate.id}`,
      type: candidate.id.endsWith("-test") ? "test" : "build",
      level: "required",
      scope: candidate.scope,
    })),
  };

  const path = resolveSafePath(context.projectRoot, PROFILE_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  // Deterministic content plus atomic write makes re-application a no-op, which the
  // crash-recovery path depends on.
  atomicWriteFileSync(path, stringify(profile));
  return [PROFILE_PATH];
}

export const verificationHandler: HandlerRegistration = { effect: "config-additive", apply };
```

Confirm the emitted document validates against `schemas/verification.schema.yaml`; adjust the
field names above to match that schema exactly before moving on.

- [ ] **Step 4: Wire the gate into `cli/commands/verify.ts`**

At the top of `verifyHandler`, before any verification work:

```ts
  const outcome = runDecisionGate({
    context: {
      projectRoot: invocation.paths.projectRoot,
      coreRoot: invocation.paths.coreRoot,
      command: "verify",
      answers: invocation.flags.answers,
      ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
    },
    providers: [verificationProvider],
    handlers: new Map([["verification.adopt", verificationHandler]]),
    persist: true,
  });

  if (outcome.problems.length > 0) {
    return createResult({
      command: "verify",
      status: "failed",
      decisions: outcome.projections,
      diagnostics: outcome.problems.map((message) => createDiagnostic({
        severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
        component: "cli.commands.verify", message,
        remediation: "Answer with one of the offered option ids.",
      })),
    });
  }

  if (outcome.status === "awaiting-input") {
    return createResult({ command: "verify", status: "awaiting_input", decisions: outcome.projections });
  }
```

Then let the existing verification execution continue unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/decisions/providers.test.ts tests/verification/verification.test.ts tests/verification/runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Manually confirm the pilot end to end**

```bash
mkdir -p /tmp/paved-pilot && cd /tmp/paved-pilot
printf '<project><artifactId>api</artifactId></project>' > pom.xml
node <paved>/cli/index.ts verify --project /tmp/paved-pilot --json
```

Expected: `"status": "awaiting_input"` with one decision, exit code 10.

```bash
node <paved>/cli/index.ts verify --project /tmp/paved-pilot \
  --answer <id>=all --answered-by you@example.com --json
```

Expected: the profile exists at `.paved/verification/profile.yaml`, and verification then
runs and reports its own result — **not** a pass inferred from the answer.

- [ ] **Step 7: Commit**

```bash
git add cli/lib/decisions/handlers/verification.ts cli/commands/verify.ts tests/decisions/providers.test.ts
git commit -m "feat: adopt detected verification gates conversationally"
```

---

### Task 16: Answered decisions as a capability-provider precedence tier

**Files:**
- Modify: `cli/lib/adapters.ts` (`resolveCapability`, `resolveCapabilities`, `capabilityEvidence`)
- Create: `cli/lib/decisions/providers/capability.ts`
- Test: `tests/adapters/scoped-providers.test.ts` (extend)

**Interfaces:**
- Consumes: `listDecisions` (Task 6).
- Produces:
  - `ScopedProvider["source"]` gains `"answered-decision"`
  - `resolveCapability(id, resolved, selection?, answered?: ReadonlyMap<string, string>)` — `answered` maps capability id → provider id
  - `capabilityProvider: DecisionProvider`

Paved never writes `.paved/manifest.yaml`; the answer stays in the decision record and is consulted here instead.

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/scoped-providers.test.ts`:

```ts
describe("answered decisions as a provider precedence tier", () => {
  it("resolves an otherwise ambiguous capability from an answered decision", () => {
    // Build two detections that both provide the same capability at the same depth.
    const resolution = resolveCapability(
      "testing-run", ambiguousDetections(), undefined,
      new Map([["testing-run", "technology/java"]]),
    );
    assert.equal(resolution.status, "explicitly-selected");
    assert.equal(resolution.provider?.id, "technology/java");
    assert.equal(resolution.scopes[0]?.source, "answered-decision");
  });

  it("lets an explicit manifest selection outrank an answered decision", () => {
    const resolution = resolveCapability(
      "testing-run", ambiguousDetections(), "technology/typescript",
      new Map([["testing-run", "technology/java"]]),
    );
    assert.equal(resolution.provider?.id, "technology/typescript");
    assert.equal(resolution.scopes[0]?.source, "explicit");
  });

  it("ignores an answered decision naming a provider that cannot supply the capability", () => {
    const resolution = resolveCapability(
      "testing-run", ambiguousDetections(), undefined,
      new Map([["testing-run", "infrastructure/git"]]),
    );
    assert.equal(resolution.status, "ambiguous");
  });

  it("still resolves deterministically when there is only one provider", () => {
    const resolution = resolveCapability("testing-run", singleDetection(), undefined, new Map());
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.scopes[0]?.source, "inferred");
  });
});
```

Add `ambiguousDetections()` and `singleDetection()` helpers to the file, reusing whatever
fixture-construction pattern the existing tests in `scoped-providers.test.ts` already use.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/adapters/scoped-providers.test.ts`
Expected: FAIL — `resolveCapability` takes three parameters.

- [ ] **Step 3: Modify `cli/lib/adapters.ts`**

Widen the source union:

```ts
export interface ScopedProvider {
  scope: string;
  provider: string;
  source: 'explicit' | 'explicit-scoped' | 'answered-decision' | 'inferred';
  evidence: string[];
}
```

Add the parameter and the new tier, placed between explicit selection and inference:

```ts
// Precedence: explicit override > explicit scoped provider > answered decision >
// deterministic inference from repository scopes > ambiguous. The human-owned manifest
// always wins; Paved never writes it.
export function resolveCapability(
  id: string,
  resolved: Detection[],
  selection?: ProviderSelection,
  answered: ReadonlyMap<string, string> = new Map(),
): CapabilityResolution {
  const providers = resolved.filter(d => d.adapter.provides?.capabilities?.some(c => c.id === id));
  const candidates = providers.map(p => p.adapter.id).sort();
  // ...existing string-selection and explicit-scoped branches unchanged...

  if (providers.length === 0) return unavailable([{ code: 'missing-provider', id, message: `No adapter provides ${id}` }]);
  if (providers.length === 1 && explicit.size === 0) { /* unchanged */ }

  const decided = answered.get(id);
  if (decided !== undefined && explicit.size === 0) {
    const match = providers.find(d => d.adapter.id === decided);
    if (match) {
      return {
        status: 'explicitly-selected',
        provider: match.adapter,
        candidates,
        scopes: [{ scope: '.', provider: match.adapter.id, source: 'answered-decision', evidence: match.evidence }],
        ambiguousScopes: [],
        diagnostics: [],
      };
    }
    // An answer naming a provider that cannot supply the capability is ignored rather
    // than fatal: the evidence moved under the answer, so the scope stays ambiguous and
    // the decision gate will supersede and re-ask.
  }

  // ...existing scope-resolution loop unchanged...
}
```

Thread the new parameter through `resolveCapabilities(resolved, selections, answered)` and
`capabilityEvidence(root, sources, resolved, selections, answered)`, defaulting to an empty map
so every existing call site compiles unchanged.

- [ ] **Step 4: Add the provider that reads answers from the store**

Create `cli/lib/decisions/providers/capability.ts`:

```ts
import { listDecisions } from "../store.ts";

/** Capability id → chosen provider id, from APPLIED capability decisions. */
export function answeredProviders(projectRoot: string): ReadonlyMap<string, string> {
  const answered = new Map<string, string>();
  for (const decision of listDecisions(projectRoot)) {
    if (decision.status !== "APPLIED") continue;
    if (decision.effect !== "record-only" || !decision.id.startsWith("d-")) continue;
    const capability = (decision as { capability?: unknown }).capability;
    if (typeof capability === "string" && typeof decision.answer === "string") {
      answered.set(capability, decision.answer);
    }
  }
  return answered;
}
```

Because `Decision` has no `capability` field, encode it in the candidate set instead: the
capability provider (below) uses `candidates: [capability, ...providerIds]`, and
`answeredProviders` reads `decision.fingerprint.inputs` for the `candidate:` entry that
matches a known capability id. Implement it that way rather than casting, and add a unit
test asserting a round trip from raised decision → answer → `answeredProviders` map.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/adapters/scoped-providers.test.ts tests/adapters/runtime-stacks.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/lib/adapters.ts cli/lib/decisions/providers/capability.ts tests/adapters/scoped-providers.test.ts
git commit -m "feat: resolve ambiguous capability providers from answered decisions"
```

---

# Stage B — Management commands

### Task 17: Rule-convention provider and handler

**Files:**
- Create: `cli/lib/decisions/providers/rules.ts`, `cli/lib/decisions/handlers/rules.ts`
- Test: `tests/decisions/providers.test.ts` (extend)

**Interfaces:**
- Produces: `rulesProvider: DecisionProvider`, `rulesHandler: HandlerRegistration` under `"rules.adopt"`, effect `config-additive`.

- [ ] **Step 1: Write the failing test**

Append to `tests/decisions/providers.test.ts`:

```ts
import { rulesProvider } from "../../cli/lib/decisions/providers/rules.ts";
import { rulesHandler } from "../../cli/lib/decisions/handlers/rules.ts";

describe("rule convention provider", () => {
  it("detects a Checkstyle configuration as a candidate rule", () => {
    const project = workspace({
      "checkstyle.xml": '<module name="Checker"></module>',
      "pom.xml": "<project><artifactId>api</artifactId></project>",
    });
    const [candidate] = rulesProvider({ ...context(project), command: "init" });
    assert.ok(candidate);
    assert.equal(candidate.required, true);
    assert.equal(candidate.effect, "config-additive");
    assert.ok(candidate.evidence.some((item) => item.location === "checkstyle.xml"));
  });

  it("classifies the convention as observed, never as desired architecture", () => {
    const project = workspace({ "checkstyle.xml": '<module name="Checker"></module>' });
    const [candidate] = rulesProvider({ ...context(project), command: "init" });
    assert.match(candidate!.reason, /observed|already/i);
    assert.doesNotMatch(candidate!.reason, /required by|must/i);
  });

  it("raises nothing when the project already has rules", () => {
    const project = workspace({
      "checkstyle.xml": '<module name="Checker"></module>',
      ".paved/rules/quality/checkstyle.yaml": "apiVersion: paved/v1\nkind: Rule\n",
    });
    assert.deepEqual(rulesProvider({ ...context(project), command: "init" }), []);
  });

  it("writes a project rule when adopted and is idempotent", () => {
    const project = workspace({ "checkstyle.xml": '<module name="Checker"></module>' });
    const changes = rulesHandler.apply("adopt", { ...context(project), command: "init" });
    assert.deepEqual(changes, [".paved/rules/quality/checkstyle.yaml"]);
    const first = readFileSync(join(project, ".paved/rules/quality/checkstyle.yaml"), "utf8");
    rulesHandler.apply("adopt", { ...context(project), command: "init" });
    assert.equal(readFileSync(join(project, ".paved/rules/quality/checkstyle.yaml"), "utf8"), first);
  });

  it("writes nothing when declined", () => {
    const project = workspace({ "checkstyle.xml": '<module name="Checker"></module>' });
    assert.deepEqual(rulesHandler.apply("decline", { ...context(project), command: "init" }), []);
    assert.equal(existsSync(join(project, ".paved/rules")), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/decisions/providers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the provider**

Create `cli/lib/decisions/providers/rules.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverSources } from "../../generator-runtime.ts";
import type { DecisionCandidate, DecisionProvider } from "../gate.ts";

const CONVENTIONS = [
  { id: "checkstyle", match: /checkstyle[^/]*\.xml$/, label: "Checkstyle configuration" },
  { id: "eslint", match: /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/, label: "ESLint configuration" },
];

export const rulesProvider: DecisionProvider = (context): readonly DecisionCandidate[] => {
  if (existsSync(join(context.projectRoot, ".paved/rules"))) return [];
  const sources = discoverSources(context.projectRoot);
  const found = CONVENTIONS.flatMap((convention) => {
    const source = sources.find((item) => convention.match.test(item.path));
    return source === undefined ? [] : [{ convention, source }];
  });
  if (found.length === 0) return [];

  return found.map(({ convention, source }) => ({
    scope: "project" as const,
    question: `Should the ${convention.label} this repository already uses become an enforced Paved rule?`,
    // Observed is not desired: the recommendation cites what the repository does, and
    // only the answer turns it into a documented, enforced project rule.
    reason:
      `Paved observed ${source.path} in this repository. Paved records observed conventions `
      + "as evidence, and only enforces one as a project rule when the project says so.",
    options: [
      {
        id: "adopt", label: "Adopt as a project rule",
        description: `Create a Paved rule backed by ${source.path}.`,
        consequence: "Reviews and workflows will cite this rule.",
      },
      {
        id: "decline", label: "Leave it observed",
        description: "Keep the configuration as repository evidence only.",
        consequence: "No Paved rule is created.",
      },
    ],
    recommended: "adopt",
    evidence: [{ type: "file" as const, location: source.path, sha256: source.sha256 }],
    required: true,
    requiredAnswer: { type: "single-choice" as const },
    effect: "config-additive" as const,
    handler: "rules.adopt",
    candidates: [convention.id],
  }));
};
```

- [ ] **Step 4: Write the handler**

Create `cli/lib/decisions/handlers/rules.ts` following the shape of
`cli/lib/decisions/handlers/verification.ts`: on `"adopt"`, write a `Rule` document to
`.paved/rules/quality/<convention>.yaml` with `id: project.quality.<convention>`, a
`status` of `active`, and `provenance` citing the detected file; on `"decline"`, return `[]`.
Use `resolveSafePath` + `atomicWriteFileSync` and deterministic content so re-application
is a no-op. Validate the emitted document against `schemas/rule.schema.yaml`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/decisions/providers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/decisions/providers/rules.ts cli/lib/decisions/handlers/rules.ts tests/decisions/providers.test.ts
git commit -m "feat: offer detected rule conventions for adoption"
```

---

### Task 18: Conversational `init`

**Files:**
- Modify: `cli/commands/init.ts`
- Test: `tests/cli/lifecycle.test.ts` (extend)

**Interfaces:**
- Consumes: `runDecisionGate`, `verificationProvider`, `rulesProvider`, `capabilityProvider`, and their handlers.
- Produces: `initHandler` returns `awaiting_input` with decisions instead of reporting an unanswered configuration proposal as an error.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/lifecycle.test.ts`:

```ts
describe("conversational init", () => {
  it("initializes, then asks rather than failing", async () => {
    const project = workspace({
      "pom.xml": "<project><artifactId>api</artifactId></project>",
      "checkstyle.xml": '<module name="Checker"></module>',
    });
    const result = await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    assert.equal(result.status, "awaiting_input");
    assert.ok((result.decisions?.length ?? 0) >= 1);
    assert.equal(existsSync(join(project, ".paved/manifest.yaml")), true,
      "init still writes the manifest before asking");
  });

  it("never reports an unanswered proposal as an initialization error", async () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const result = await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    assert.notEqual(result.status, "failed");
    assert.equal(result.diagnostics.some((item) => item.category !== "findings"), false);
  });

  it("applies answers and reaches a healthy lifecycle without manual editing", async () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const asked = await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    const answers = (asked.decisions ?? []).flatMap((decision) => [
      "--answer", `${decision.id}=${decision.recommended ?? decision.options[0]!.id}`,
    ]);
    const applied = await dispatchCli({
      argv: ["init", "--project", project, ...answers, "--answered-by", "anderson@example.com", "--json"],
    });
    assert.notEqual(applied.status, "failed");
    assert.equal(existsSync(join(project, ".paved/verification/profile.yaml")), true);

    const status = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    const state = (status.data as { lifecycleState: string }).lifecycleState;
    assert.ok(["VALIDATED", "READY"].includes(state), `unexpected lifecycle state: ${state}`);
  });

  it("does not re-ask an already answered decision", async () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const asked = await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    const id = asked.decisions![0]!.id;
    await dispatchCli({
      argv: ["init", "--project", project, "--answer", `${id}=all`, "--answered-by", "a@example.com", "--json"],
    });
    const again = await dispatchCli({ argv: ["verify", "--project", project, "--json"] });
    assert.equal(again.decisions?.some((decision) => decision.id === id), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/lifecycle.test.ts`
Expected: FAIL — `init` returns `success`/`warning` with no decisions.

- [ ] **Step 3: Modify `cli/commands/init.ts`**

Keep every existing behaviour — the already-initialized guard, `--adapter` rejection,
`--dry-run`, `--no-generate`, `initializeConsumer`, `runGenerators`. After generation and
the `inspectConsumer` call, and only when not `--dry-run`, run the gate:

```ts
  const outcome = runDecisionGate({
    context: {
      projectRoot: invocation.paths.projectRoot,
      coreRoot: invocation.paths.coreRoot,
      command: "init",
      answers: invocation.flags.answers,
      ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
    },
    providers: [verificationProvider, rulesProvider, capabilityProvider],
    handlers: new Map([
      ["verification.adopt", verificationHandler],
      ["rules.adopt", rulesHandler],
      ["capability.select", capabilityHandler],
    ]),
    persist: true,
  });
```

Re-run `inspectConsumer` after the gate so `lifecycleState` reflects any file the answers
produced, then return:

```ts
  const lifecycleState = inspectConsumer({ /* as before */ }).lifecycleState;
  const base = {
    initialized: true, dryRun: false, projectName,
    selectedAdapters: plan.selectedAdapters,
    resolvedAdapters: plan.resolvedAdapters,
    capabilityProviders: plan.capabilityProviders,
    generated: true, lifecycleState,
    generation: generateData(generation, false),
  };

  if (outcome.status === "awaiting-input") {
    // A material unanswered configuration proposal is a question, not an error: the
    // generation findings stay attached, but nothing blocking is reported.
    return createResult({
      command: "init",
      status: "awaiting_input",
      data: base,
      decisions: outcome.projections,
      diagnostics: diagnostics.filter((item) => item.category === "findings"),
    });
  }

  return createResult({
    command: "init", status: statusFor(diagnostics), data: base,
    ...(outcome.projections.length === 0 ? {} : { decisions: outcome.projections }),
    diagnostics,
  });
```

If `diagnostics` contains a blocking entry, keep the existing failure path and do **not**
return `awaiting_input` — the `createResult` invariant from Task 7 would reject it anyway.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cli/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/init.ts tests/cli/lifecycle.test.ts
git commit -m "feat: make init a conversational setup process"
```

---

### Task 19: `status` reports pending decisions

**Files:**
- Modify: `cli/commands/status.ts`, `cli/lib/consumer-state.ts`
- Test: `tests/cli/commands.test.ts` (extend)

**Interfaces:**
- Produces: `ConsumerInspection` gains `pendingDecisions: { id; question; required }[]` and `pendingApprovals: string[]`; `statusData` exposes `pendingDecisions`, `pendingApprovals`, `verificationReadiness`, `unavailableCommands`, `nextAction`.

`status` is read-only: it **never** raises a decision and never returns `awaiting_input`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/commands.test.ts`:

```ts
describe("status decision reporting", () => {
  it("reports waiting decisions instead of telling the user to edit files", async () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    const result = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    const data = result.data as { pendingDecisions: { id: string }[]; nextAction: string };
    assert.ok(data.pendingDecisions.length >= 1);
    assert.match(data.nextAction, /decision/i);
    assert.doesNotMatch(data.nextAction, /edit|create .*\.yaml/i);
  });

  it("never returns awaiting_input, because it is read-only", async () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    const result = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    assert.notEqual(result.status, "awaiting_input");
  });

  it("reports verification readiness and unavailable commands", async () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    await dispatchCli({ argv: ["init", "--project", project, "--json"] });
    const data = (await dispatchCli({ argv: ["status", "--project", project, "--json"] })).data as {
      verificationReadiness: string; unavailableCommands: { name: string; reason: string }[];
    };
    assert.equal(typeof data.verificationReadiness, "string");
    assert.ok(Array.isArray(data.unavailableCommands));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/commands.test.ts`
Expected: FAIL — `pendingDecisions` is undefined.

- [ ] **Step 3: Implement**

In `cli/lib/consumer-state.ts`, extend `ConsumerInspection` with:

```ts
  readonly pendingDecisions: readonly { id: string; question: string; required: boolean }[];
  readonly pendingApprovals: readonly string[];
```

Populate both in `inspectConsumer` from `listDecisions(input.projectRoot)` — pending means
status `PENDING` or `ASKED`; pending approvals are those with
`answer_channel === "human-authored"` and status `ASKED`. Return empty arrays in the two
early-return uninitialized branches.

In `cli/commands/status.ts`, extend `statusData`:

```ts
export function statusData(inspection: ConsumerInspection): Record<string, unknown> {
  const waiting = inspection.pendingDecisions.filter((item) => item.required);
  return {
    // ...all existing fields unchanged...
    pendingDecisions: inspection.pendingDecisions,
    pendingApprovals: inspection.pendingApprovals,
    verificationReadiness: inspection.verificationProfile === "present" ? "ready"
      : inspection.pendingDecisions.length > 0 ? "awaiting-decision" : "unconfigured",
    unavailableCommands: unavailableCommandsFor(inspection),
    nextAction: waiting.length > 0
      ? `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Run paved status --json to read them, then answer with --answer <id>=<value> --answered-by <you>.`
      : nextActionFor(inspection),
  };
}
```

Implement `unavailableCommandsFor` by reusing `discoverAgentCommands(inspection.projectRoot,
inspection.coreRoot)` and mapping unavailable entries to `{ name, reason, recommendedNextAction }`.
Implement `nextActionFor` to return the existing lifecycle-appropriate guidance, phrased as
an action, never as "edit file X".

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/status.ts cli/lib/consumer-state.ts tests/cli/commands.test.ts
git commit -m "feat: report pending decisions and next action in status"
```

---

### Task 20: Ambiguous testing tool becomes a decision

**Files:**
- Create: `cli/lib/decisions/providers/testing.ts`, `cli/lib/decisions/handlers/testing.ts`
- Modify: `cli/lib/test-runner.ts:162`, `cli/commands/test.ts`, `cli/lib/agent-commands.ts:84`
- Test: `tests/tools/test-command.test.ts` (extend)

**Interfaces:**
- Produces: `resolveTestingTool` returns a new `{ status: "ambiguous"; candidates: string[] }` variant for `tools.length > 1`, keeping `{ status: "unavailable" }` for `tools.length === 0`.

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/test-command.test.ts`:

```ts
describe("testing tool ambiguity", () => {
  it("asks which testing tool to use when more than one is declared", async () => {
    const project = projectWithTwoTestingTools();
    const result = await dispatchCli({ argv: ["test", "--project", project, "--json"] });
    assert.equal(result.status, "awaiting_input");
    assert.equal(result.decisions?.length, 1);
    assert.ok((result.decisions![0]!.options.length ?? 0) >= 2);
  });

  it("still blocks, without asking, when NO testing tool is declared", async () => {
    // Phase 22: absence is not askable. Paved must not invite the user to bless a
    // capability that has no approved implementation.
    const project = projectWithNoTestingTool();
    const result = await dispatchCli({ argv: ["test", "--project", project, "--json"] });
    assert.equal(result.status, "failed");
    assert.equal(result.decisions, undefined);
    assert.ok(result.diagnostics.some((item) => item.code === "PAVED_TEST_TOOL_AMBIGUOUS"
      || item.code === "PAVED_TEST_TOOL_UNAVAILABLE"));
  });

  it("only offers implementations that already pass authorization", async () => {
    const project = projectWithTwoTestingToolsOneUnauthorized();
    const result = await dispatchCli({ argv: ["test", "--project", project, "--json"] });
    const offered = result.decisions?.[0]?.options.map((option) => option.id) ?? [];
    assert.equal(offered.includes("unauthorized-tool"), false);
  });
});
```

Add the three fixture helpers using the pattern already present in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/tools/test-command.test.ts`
Expected: FAIL — `test` currently fails with `PAVED_TEST_TOOL_AMBIGUOUS` for both cases.

- [ ] **Step 3: Implement**

In `cli/lib/test-runner.ts`, split the `tools.length !== 1` branch:

```ts
  if (tools.length > 1) {
    return {
      status: "ambiguous",
      candidates: tools.map((tool) => tool.id).sort((a, b) => a.localeCompare(b, "en")),
    };
  }
  if (tools.length === 0) {
    return {
      status: "unavailable",
      code: "PAVED_TEST_TOOL_UNAVAILABLE",
      message: "No available testing-run Tool is declared.",
      remediation: "Declare a project testing Tool or select a technology adapter that provides one.",
    };
  }
```

Widen `TestingToolResolution` with the `ambiguous` variant. Update every call site that
assumed two variants — `cli/lib/agent-commands.ts:74` and `:88` treat `ambiguous` as
*available, will ask* rather than unavailable.

Create `cli/lib/decisions/providers/testing.ts` returning a single-choice decision whose
options are the ambiguous candidate tool ids (each already authorized, since
`resolveTestingTool` filters to `availability === "available"` before this point), with
`effect: "config-additive"` and `handler: "testing.select"`. Create
`cli/lib/decisions/handlers/testing.ts` writing a `ToolImplementation` binding to
`.paved/tool-implementations/testing-run.yaml`, deterministic and idempotent.

Wire the gate into `cli/commands/test.ts` exactly as Task 15 did for `verify`.

- [ ] **Step 4: Update command availability**

In `cli/lib/agent-commands.ts`, change the profile check at line 84:

```ts
  if (["feature", "fix", "refactor", "implement"].includes(command.name)) {
    if (inspection.verificationProfile !== "present") {
      // A profile Paved can offer to create is a question, not an unavailability.
      const candidates = detectCheckCandidates(projectRoot);
      if (candidates.length === 0) {
        return {
          available: false,
          reason: "An executable workflow needs a verification profile, and no repository check was detected.",
          recommendedNextAction: "Add a build or test command to the repository, then run /paved:init.",
        };
      }
    }
    const resolution = resolveTestingTool(projectRoot, coreRoot);
    if (resolution.status === "unavailable") {
      return { available: false, reason: resolution.message, recommendedNextAction: resolution.remediation };
    }
  }
```

Apply the same treatment to the `verify` branch at line 93.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/tools/test-command.test.ts tests/tools/tools.test.ts tests/agent-contract/synthetic-agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/test-runner.ts cli/lib/agent-commands.ts cli/commands/test.ts cli/lib/decisions/providers/testing.ts cli/lib/decisions/handlers/testing.ts tests/tools/test-command.test.ts
git commit -m "feat: ask which testing tool to use when more than one is declared"
```

---

# Stage C — Workflow commands

### Task 21: Run-scoped decisions in `feature`, `fix` and `refactor`

**Files:**
- Modify: `cli/commands/workflow.ts`
- Test: `tests/workflows/execution.test.ts` (extend)

**Interfaces:**
- Produces: `Run` gains `decisions?: Decision[]`; `advance` runs the gate before phase work and returns `awaiting_input` when a required run-scoped decision is open; `result()` attaches projections.

- [ ] **Step 1: Write the failing test**

Append to `tests/workflows/execution.test.ts`:

```ts
describe("run-scoped decisions", () => {
  it("returns awaiting_input and persists the decision inside the run", async () => {
    const project = readyProject();
    const started = await dispatchCli({ argv: ["feature", "add SSO", "--project", project, "--json"] });
    const runId = (started.data as { run: string }).run;
    await dispatchCli({
      argv: ["decision", "raise", "--decision", JSON.stringify({
        question: "Which identity provider should SSO use?",
        reason: "Repository evidence does not determine the intended product behaviour.",
        options: [
          { id: "keycloak", label: "Keycloak", description: "Self-hosted.", consequence: "Adds Keycloak." },
          { id: "auth0", label: "Auth0", description: "Hosted.", consequence: "Adds Auth0." },
        ],
        evidence: [{ type: "file", location: "README.md", sha256: "a".repeat(64) }],
        required: true, requiredAnswer: { type: "single-choice" },
        effect: "record-only", candidates: ["keycloak", "auth0"], run: runId,
      }), "--project", project, "--json"],
    });
    const blocked = await dispatchCli({
      argv: ["feature", "add SSO", "--run", runId, "--advance", "--note", "n", "--project", project, "--json"],
    });
    assert.equal(blocked.status, "awaiting_input");
    assert.equal(blocked.decisions?.[0]?.runId, runId);
  });

  it("resumes the same run after the answer", async () => {
    const project = readyProject();
    const { runId, decisionId: id } = await startFeatureWithOpenDecision(project);
    const resumed = await dispatchCli({
      argv: ["feature", "add SSO", "--run", runId, "--advance", "--note", "Chose Keycloak",
        "--answer", `${id}=keycloak`, "--answered-by", "anderson@example.com",
        "--project", project, "--json"],
    });
    assert.notEqual(resumed.status, "awaiting_input");
    assert.equal((resumed.data as { run: string }).run, runId);
  });

  it("survives an agent restart — a fresh process sees the same open decision", async () => {
    const project = readyProject();
    const { runId, decisionId: id } = await startFeatureWithOpenDecision(project);
    const reread = await dispatchCli({ argv: ["decision", "show", id, "--project", project, "--json"] });
    assert.equal((reread.data as { decision: { status: string } }).decision.status, "ASKED");
    assert.ok(runId);
  });

  it("still requires a human-authored file for plan approval", async () => {
    // The relayed channel must not satisfy the plan gate.
    const project = readyProject();
    const runId = await startFeatureAtPlanning(project);
    const result = await dispatchCli({
      argv: ["feature", "add SSO", "--run", runId, "--advance",
        "--answer", "d-0123456789abcdef0123=approve", "--answered-by", "anderson@example.com",
        "--project", project, "--json"],
    });
    assert.notEqual(result.status, "success");
    assert.match(JSON.stringify(result), /approvals/);
  });
});
```

Add `readyProject()`, `startFeatureWithOpenDecision()` and `startFeatureAtPlanning()` helpers
reusing the fixture pattern already in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/workflows/execution.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `cli/commands/workflow.ts`:

- Extend the `Run` interface with `decisions?: Decision[]`.
- At the top of `advance`, before phase dispatch, run the gate with
  `context.run = run.id`, providers reading run-scoped decisions from `run.decisions`, and
  the handler map containing only `record-only` handlers.
- Merge gate results back into `run.decisions`, push `decision-raised` / `decision-answered`
  / `decision-applied` events, and `save(run, workflow, invocation)`.
- When `outcome.status === "awaiting-input"`, set `run.status = "awaiting-input"` and return
  `createResult({ command, status: "awaiting_input", data: {...}, decisions: outcome.projections })`.
- Leave the entire `planning` branch — `plan_sha256`, `.paved/approvals/<run-id>.json`,
  `approval()` — **unchanged**. Plan approval keeps its human-authored channel.
- Extend `result()` to attach `decisions` when the run has open ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/workflows/execution.test.ts tests/workflows/workflows.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/commands/workflow.ts tests/workflows/execution.test.ts
git commit -m "feat: resolve run-scoped decisions inside executable workflows"
```

---

### Task 22: `doctor` proposes repairs without persisting

**Files:**
- Create: `cli/lib/decisions/providers/repair.ts`, `cli/lib/decisions/handlers/repair.ts`
- Modify: `cli/commands/doctor.ts`
- Test: `tests/cli/commands.test.ts` (extend)

**Interfaces:**
- Produces: `repairProvider: DecisionProvider` emitting `required: false` candidates with `effect: "repository-mutating"`; `repairHandler` registered under `"repair.apply"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/commands.test.ts`:

```ts
describe("doctor repair proposals", () => {
  it("proposes a repair without writing anything", async () => {
    const project = projectWithStaleGeneratedContext();
    const result = await dispatchCli({ argv: ["doctor", "--project", project, "--json"] });
    assert.ok((result.decisions?.length ?? 0) >= 1);
    assert.equal(existsSync(join(project, ".paved/decisions")), false,
      "doctor is read-only by default and must not persist a decision");
  });

  it("does not block, because repairs are optional", async () => {
    const project = projectWithStaleGeneratedContext();
    const result = await dispatchCli({ argv: ["doctor", "--project", project, "--json"] });
    assert.notEqual(result.status, "awaiting_input");
    assert.equal(result.decisions?.[0]?.required, false);
  });

  it("states what it found, what it would change, why, the risk and the files", async () => {
    const project = projectWithStaleGeneratedContext();
    const decision = (await dispatchCli({ argv: ["doctor", "--project", project, "--json"] })).decisions![0]!;
    assert.ok(decision.reason.length > 0);
    assert.ok(decision.evidence.length > 0);
    assert.equal(decision.risk, "high");
    assert.ok(decision.options.every((option) => option.consequence.length > 0));
  });

  it("requires a human-authored approval before repairing", async () => {
    const project = projectWithStaleGeneratedContext();
    const decision = (await dispatchCli({ argv: ["doctor", "--project", project, "--json"] })).decisions![0]!;
    assert.equal(decision.answerChannel, "human-authored");
    const attempted = await dispatchCli({
      argv: ["doctor", "--project", project, "--answer", `${decision.id}=apply`,
        "--answered-by", "anderson@example.com", "--json"],
    });
    assert.match(JSON.stringify(attempted), /approvals/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/cli/commands.test.ts`
Expected: FAIL — `doctor` emits no decisions.

- [ ] **Step 3: Implement**

`repairProvider` maps repairable `inspectConsumer` diagnostics — `PAVED_GENERATED_SOURCE_STALE`,
`PAVED_GENERATOR_INPUTS_STALE`, `PAVED_GENERATED_OUTPUT_MISSING` — to candidates with
`required: false`, `effect: "repository-mutating"`, options `apply` / `skip`, a `reason`
naming what was found and why, and `evidence` citing the affected files.

In `cli/commands/doctor.ts`, call `runDecisionGate` with `persist: false` when no `--answer`
is supplied, and `persist: true` when one is. Because ids are content-derived (Task 2), an
answer can reference an id that was never written to disk. Attach `outcome.projections` to
the existing read-only result.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/providers/repair.ts cli/lib/decisions/handlers/repair.ts cli/commands/doctor.ts tests/cli/commands.test.ts
git commit -m "feat: propose doctor repairs conversationally without writing"
```

---

### Task 23: `gardener` proposal adoption and `update` migration decisions

**Files:**
- Create: `cli/lib/decisions/providers/gardener.ts`, `cli/lib/decisions/handlers/gardener.ts`
- Modify: `cli/commands/gardener.ts`, `cli/commands/update.ts`
- Test: `tests/gardener/gardener.test.ts` (extend), `tests/cli/commands.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/gardener/gardener.test.ts`:

```ts
describe("conversational gardener adoption", () => {
  it("offers CANDIDATE proposals for adoption as optional decisions", async () => {
    const project = projectWithRecurringProposals();
    const result = await dispatchCli({ argv: ["gardener", "--project", project, "--json"] });
    assert.ok((result.decisions?.length ?? 0) >= 1);
    assert.equal(result.decisions?.[0]?.required, false);
  });

  it("never enforces a proposal automatically", async () => {
    const project = projectWithRecurringProposals();
    await dispatchCli({ argv: ["gardener", "--project", project, "--json"] });
    assert.equal(existsSync(join(project, ".paved/rules")), false);
  });

  it("materializes the rule only after an answer, and never writes reviews.yaml", async () => {
    const project = projectWithRecurringProposals();
    const decision = (await dispatchCli({ argv: ["gardener", "--project", project, "--json"] })).decisions![0]!;
    await dispatchCli({
      argv: ["gardener", "--project", project, "--answer", `${decision.id}=adopt`,
        "--answered-by", "anderson@example.com", "--json"],
    });
    assert.equal(existsSync(join(project, ".paved/rules")), true);
    assert.equal(existsSync(join(project, ".paved/gardener/reviews.yaml")), false,
      "reviews.yaml is human-owned and Paved must never write it");
  });
});
```

Append to `tests/cli/commands.test.ts`:

```ts
describe("update migration decisions", () => {
  it("asks before applying a known required migration", async () => {
    const project = projectNeedingKnownMigration();
    const result = await dispatchCli({ argv: ["update", "--project", project, "--json"] });
    assert.equal(result.status, "awaiting_input");
  });

  it("keeps unknown compatibility a blocker rather than a question", async () => {
    // "No evidence proves this update is safe" is unsafe, not material.
    const project = projectWithUnknownCompatibility();
    const result = await dispatchCli({ argv: ["update", "--project", project, "--json"] });
    assert.equal(result.status, "failed");
    assert.ok(result.diagnostics.some((item) => item.code === "PAVED_UPDATE_COMPATIBILITY_UNKNOWN"));
    assert.equal(result.decisions, undefined);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/gardener/gardener.test.ts tests/cli/commands.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`gardenerProvider` maps `analyzeGardener(...).proposals` with `status === "CANDIDATE"` to
optional decisions (`effect: "config-additive"`, handler `"gardener.adopt"`, options
`adopt` / `decline`). `gardenerHandler` writes the rule into `.paved/rules/` and returns the
written path — it must never touch `.paved/gardener/reviews.yaml`.

In `cli/commands/update.ts`, run the gate over `planConsumerUpdate`'s result. Convert only
`PAVED_UPDATE_MIGRATION_REQUIRED` into a decision (`effect: "lock-transaction"`). Leave
`PAVED_UPDATE_COMPATIBILITY_UNKNOWN`, `PAVED_MANIFEST_CORE_INCOMPATIBLE`,
`PAVED_RUNTIME_UPDATE_REQUIRED` and every `PAVED_LOCK_*` diagnostic as blocking — an answer
must not be able to override an integrity or compatibility failure.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/gardener/gardener.test.ts tests/cli/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/lib/decisions/providers/gardener.ts cli/lib/decisions/handlers/gardener.ts cli/commands/gardener.ts cli/commands/update.ts tests/gardener/gardener.test.ts tests/cli/commands.test.ts
git commit -m "feat: adopt gardener proposals and update migrations conversationally"
```

---

# Stage D — Agent integrations, documentation, acceptance

### Task 24: The canonical `decisions` skill

**Files:**
- Create: `core/skills/decisions/decisions/SKILL.md`, `core/skills/decisions/decisions/skill.yaml`
- Test: `tests/skills/skills.test.ts` (runs automatically over all skills)

**Interfaces:**
- Produces: skill id `core.decisions.decisions`, referenced by every conversational command document.

The protocol lives here exactly **once**. `assessWorkflowQuality` runs `duplicatedSentences`
across skill and workflow bodies (`cli/lib/workflows.ts:201`), so restating this prose in
fourteen command documents would fail the existing quality gate.

- [ ] **Step 1: Write `skill.yaml`**

Model it on an existing contract such as `core/skills/discovery/context-discovery/skill.yaml`:
same `apiVersion`, `kind: Skill`, `status: active`, a `description` beginning "Use when …",
no required tools, and no dependencies.

- [ ] **Step 2: Write `SKILL.md`**

The body must cover, in this order:

1. **Presenting a decision** — what Paved detected; what decision remains; why it matters;
   the options; Paved's recommendation and the evidence behind it; what happens after the
   answer.
2. **Batching** — present all emitted decisions together; never invent an order Paved did
   not impose through `dependsOn`.
3. **Collecting the answer** — resume the *same* command with
   `--answer <id>=<value> --answered-by <identity>`, repeating `--answer` for multi-choice.
4. **Prohibitions**, stated plainly:
   - Never answer a material decision on the user's behalf.
   - Never supply `--answered-by` with a value the user did not give you.
   - Never offer an option Paved did not include in `options`.
   - Never use `decision raise` to route around a decision Paved already raised.
   - When `answerChannel` is `human-authored`, explain that a person must author
     `.paved/approvals/<id>.json`; do not write that file.
5. **Unavailability is not a question** — when Paved reports a blocking diagnostic, relay
   the blocker; do not convert it into a choice.

Keep the body under the line limit enforced for skills, and make every sentence specific to
this protocol so `genericityProblems` and `duplicatedSentences` both pass.

- [ ] **Step 3: Run the skills suite**

Run: `node --test tests/skills/skills.test.ts tests/core/links.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add core/skills/decisions
git commit -m "feat: add the canonical decision interaction skill"
```

---

### Task 25: Host parity in the shared projection

**Files:**
- Modify: `integrations/shared/commands.ts`, `integrations/shared/projection.ts`
- Test: `tests/integrations/projection.test.ts` (extend), `tests/docs/agent-integration.test.ts`

**Interfaces:**
- Produces: `AgentCommandContract` gains `interaction`, `decisionSources`, `answerChannels`; `renderCommand` emits a conversational contract block.

- [ ] **Step 1: Write the failing test**

Append to `tests/integrations/projection.test.ts`:

```ts
describe("conversational contract parity", () => {
  it("emits the same conversational contract for both hosts", () => {
    const command = AGENT_COMMANDS.find((item) => item.name === "verify")!;
    const codex = renderCommand(command, {
      headerLine: "<!-- h -->", title: "$paved-verify",
      launcher: { command: "node bootstrap.mjs" },
      frontmatter: { name: "paved-verify", description: command.description },
    });
    const claude = renderCommand(command, {
      headerLine: "<!-- h -->", title: "/paved:verify",
      launcher: { command: "node bootstrap.mjs" },
    });
    for (const text of [codex, claude]) {
      assert.match(text, /awaiting_input/);
      assert.match(text, /--answer <decision-id>=<value>/);
      assert.match(text, /--answered-by/);
      assert.match(text, /core\.decisions\.decisions/);
    }
  });

  it("does not restate the protocol — it references the skill", () => {
    const command = AGENT_COMMANDS.find((item) => item.name === "verify")!;
    const text = renderCommand(command, {
      headerLine: "<!-- h -->", title: "/paved:verify", launcher: { command: "node b.mjs" },
    });
    assert.doesNotMatch(text, /Never answer a material decision/,
      "the prohibitions belong to the skill, not to every command document");
  });

  it("marks read-only commands as non-conversational", () => {
    assert.equal(AGENT_COMMANDS.find((item) => item.name === "status")!.interaction, "read-only");
    assert.equal(AGENT_COMMANDS.find((item) => item.name === "verify")!.interaction, "conversational");
  });

  it("declares where each command's decisions come from", () => {
    assert.deepEqual(AGENT_COMMANDS.find((item) => item.name === "verify")!.decisionSources, ["runtime"]);
    assert.deepEqual(AGENT_COMMANDS.find((item) => item.name === "plan")!.decisionSources, ["agent"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/integrations/projection.test.ts`
Expected: FAIL — the fields do not exist.

- [ ] **Step 3: Implement**

In `integrations/shared/commands.ts`, extend the contract:

```ts
export interface AgentCommandContract {
  // ...existing fields unchanged...
  readonly interaction: "conversational" | "read-only";
  readonly decisionSources: readonly ("runtime" | "agent")[];
  readonly answerChannels: readonly ("relayed" | "human-authored")[];
}
```

Add the three fields to every entry in `COMMAND_DEFINITIONS`:

| Command | `interaction` | `decisionSources` | `answerChannels` |
|---|---|---|---|
| `init` | conversational | `["runtime"]` | `["relayed"]` |
| `status` | read-only | `[]` | `[]` |
| `plan` | conversational | `["agent"]` | `["relayed"]` |
| `implement` | conversational | `["runtime", "agent"]` | `["relayed"]` |
| `test` | conversational | `["runtime"]` | `["relayed"]` |
| `verify` | conversational | `["runtime"]` | `["relayed"]` |
| `review` | conversational | `["agent"]` | `["relayed"]` |
| `debug` | read-only | `[]` | `[]` |
| `refactor` | conversational | `["runtime", "agent"]` | `["relayed", "human-authored"]` |
| `feature` | conversational | `["runtime", "agent"]` | `["relayed", "human-authored"]` |
| `fix` | conversational | `["runtime", "agent"]` | `["relayed", "human-authored"]` |
| `update` | conversational | `["runtime"]` | `["relayed"]` |
| `doctor` | conversational | `["runtime"]` | `["human-authored"]` |
| `gardener` | conversational | `["runtime"]` | `["relayed"]` |

In `integrations/shared/projection.ts`, inside `renderCommand`, append a section when
`command.interaction === "conversational"`:

```ts
    "## Conversational contract",
    "",
    `1. Invoke the command. If it returns \`"status": "awaiting_input"\`, it is waiting on you.`,
    "2. Present every decision in `decisions[]` to the user: what Paved detected, what",
    "   remains to decide, why it matters, the options, Paved's recommendation and its evidence.",
    "3. Collect the user's answer. Do not answer on their behalf.",
    `4. Resume the same command with \`--answer <decision-id>=<value> --answered-by <identity>\`,`,
    "   repeating `--answer` once per value for a multi-choice decision.",
    "5. Present the result.",
    "",
    "Follow `core.decisions.decisions` for the full interaction protocol and its prohibitions.",
    "",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/integrations/projection.test.ts tests/docs/agent-integration.test.ts tests/agent-contract/synthetic-agent.test.ts`
Expected: PASS. `synthetic-agent.test.ts` builds an `AgentIntegration` document from
`AGENT_COMMANDS`; add the three fields to `schemas/agent-integration.schema.yaml` if it
validates them.

- [ ] **Step 5: Rebuild the distributed plugin and check drift**

Run: `npm run build:plugin && npm run check:plugin`
Expected: the plugin regenerates and the drift check passes.

- [ ] **Step 6: Commit**

```bash
git add integrations/ schemas/agent-integration.schema.yaml plugins/ tests/integrations/projection.test.ts
git commit -m "feat: expose the conversational contract to Codex and Claude Code"
```

---

### Task 26: Documentation

**Files:**
- Create: `docs/concepts/decisions.md`, `docs/decisions/0028-conversational-decision-resolution.md`
- Modify: `docs/getting-started/integrating-a-repository.md`, `docs/concepts/{workflow-approval,workflow-state,tool-results,ownership-and-regeneration,agent-integration,agent-commands,verification}.md`, `README.md`
- Test: `tests/core/links.test.ts`, `tests/docs/agent-integration.test.ts`

- [ ] **Step 1: Write `docs/concepts/decisions.md`**

Cover: the three categories and why `unsafe` is a diagnostic rather than a question; the
seven states and their transitions; the narrow fingerprint rule; the three stores and why
deterministic decisions get no file; the two answer channels and what each one proves;
resume and batching; and the CLI surface.

- [ ] **Step 2: Write ADR 0028**

Follow the format of `docs/decisions/0027-scoped-capability-provider-resolution.md`:
Status, Date, Context, Decision, Consequences, Alternatives considered, References.
Record the alternatives rejected during design — extending `gateRecord` instead of a new
record, and a standalone decision store — and the reasons.

- [ ] **Step 3: Rewrite `docs/getting-started/integrating-a-repository.md`**

Replace the instruction at line 51 — *"Copy `core/templates/verification-profile.yaml` to
`.paved/verification/profile.yaml`"* — with the conversational flow:

```
/paved:init
  → Paved detects the stack and resolves what the evidence proves
  → Paved asks which detected checks should become verification gates
  → you answer
  → Paved writes .paved/verification/profile.yaml itself
/paved:status   → GENERATED → VALIDATED → READY
```

Move direct file configuration into a clearly labelled **"Direct configuration (advanced)"**
subsection. Do not delete it: Phase 24 keeps hand-configured repositories supported, and
those users need documentation.

- [ ] **Step 4: Update the remaining documents**

Per the table in spec §9 — the risk-tiered channel in `workflow-approval.md`; the
`awaiting-input` run status, `decisions[]` and new events in `workflow-state.md`;
`awaiting_input`, exit code 10 and top-level `decisions` in `tool-results.md`;
`.paved/decisions/`, `.paved/approvals/` and "Paved never writes human-owned files" in
`ownership-and-regeneration.md`; the conversational loop in `agent-integration.md` and
`agent-commands.md`; profile adoption and "choosing is not passing" in `verification.md`;
the `User ↕ Agent ↕ Paved` principle in `README.md`.

- [ ] **Step 5: Run the documentation suites**

Run: `node --test tests/core/links.test.ts tests/docs/agent-integration.test.ts tests/core/references.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/ README.md
git commit -m "docs: establish the agent as the configuration interface"
```

---

### Task 27: The clean-room no-manual-configuration acceptance test

**Files:**
- Create: `tests/acceptance/no-manual-configuration.test.ts`

**Interfaces:**
- Consumes: the full CLI.
- Produces: the Phase 19 proof.

The guard makes the test **self-enforcing**: if any flow needs manual editing, the test
fails by construction rather than by an assertion someone forgot to write.

- [ ] **Step 1: Write the test**

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { dispatchCli } from "../../cli/runtime.ts";

const FORBIDDEN = [
  ".paved/manifest.yaml",
  ".paved/paved.lock",
  ".paved/verification/profile.yaml",
  /^\.paved\/tools\//,
  /^\.paved\/rules\//,
];

const workspaces: string[] = [];
after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

/**
 * Every write the harness performs goes through here. Touching a path the user is not
 * supposed to edit throws, so a flow that requires manual configuration cannot pass.
 */
function userWrite(project: string, path: string, content: string): void {
  const normalized = relative(project, join(project, path)).split("\\").join("/");
  for (const rule of FORBIDDEN) {
    const hit = typeof rule === "string" ? normalized === rule : rule.test(normalized);
    if (hit) throw new Error(`Clean-room violation: the user must never edit ${normalized}`);
  }
  mkdirSync(join(project, path, ".."), { recursive: true });
  writeFileSync(join(project, path), content);
}

function cleanRepository(files: Record<string, string>): string {
  const project = mkdtempSync(join(tmpdir(), "paved-cleanroom-"));
  workspaces.push(project);
  for (const [path, content] of Object.entries(files)) userWrite(project, path, content);
  return project;
}

async function answerEverything(project: string, command: string, args: readonly string[]) {
  let result = await dispatchCli({ argv: [command, ...args, "--project", project, "--json"] });
  for (let round = 0; round < 10 && result.status === "awaiting_input"; round += 1) {
    const answers = (result.decisions ?? [])
      .filter((decision) => decision.required && decision.answerChannel === "relayed")
      .flatMap((decision) => ["--answer", `${decision.id}=${decision.recommended ?? decision.options[0]!.id}`]);
    if (answers.length === 0) break;
    result = await dispatchCli({
      argv: [command, ...args, ...answers, "--answered-by", "anderson@example.com",
        "--project", project, "--json"],
    });
  }
  return result;
}

const APECATUS_SHAPED = {
  "backend/pom.xml": "<project><artifactId>apecatus-api</artifactId></project>",
  "backend/src/main/java/App.java": "class App {}\n",
  "backend/checkstyle.xml": '<module name="Checker"></module>',
  "frontend/package.json": JSON.stringify({ name: "ui", scripts: { build: "ng build", test: "ng test" } }),
  "frontend/src/app/app.component.ts": "export class AppComponent {}\n",
  "README.md": "# Apecatus-shaped fixture\n",
};

describe("no manual configuration is ever required", () => {
  it("completes init through a conversation alone", async () => {
    const project = cleanRepository(APECATUS_SHAPED);
    const result = await answerEverything(project, "init", []);
    assert.notEqual(result.status, "failed");

    const status = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    const data = status.data as { lifecycleState: string; verificationReadiness: string };
    assert.ok(["GENERATED", "VALIDATED", "READY"].includes(data.lifecycleState), data.lifecycleState);
    assert.equal(data.verificationReadiness, "ready");
  });

  it("resolves both stacks without provider ambiguity", async () => {
    const project = cleanRepository(APECATUS_SHAPED);
    await answerEverything(project, "init", []);
    const status = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    const providers = (status.data as { capabilityProviders: { status: string }[] }).capabilityProviders;
    assert.equal(providers.some((entry) => entry.status === "ambiguous"), false);
  });

  it("never instructs the user to edit a Paved file", async () => {
    const project = cleanRepository(APECATUS_SHAPED);
    const result = await answerEverything(project, "init", []);
    const rendered = JSON.stringify(result);
    assert.doesNotMatch(rendered, /Copy .*template/i);
    assert.doesNotMatch(rendered, /Create \.paved\/verification\/profile\.yaml/i);
    assert.doesNotMatch(rendered, /Edit \.paved\//i);
  });

  for (const command of ["verify", "gardener", "doctor"]) {
    it(`completes ${command} without manual configuration`, async () => {
      const project = cleanRepository(APECATUS_SHAPED);
      await answerEverything(project, "init", []);
      const result = await answerEverything(project, command, []);
      assert.notEqual(result.status, "awaiting_input",
        `${command} still needs an answer it never offered a relayed channel for`);
    });
  }

  for (const command of ["feature", "fix", "refactor"]) {
    it(`starts ${command} without manual configuration`, async () => {
      const project = cleanRepository(APECATUS_SHAPED);
      await answerEverything(project, "init", []);
      const result = await answerEverything(project, command, ["do the thing"]);
      // The run may legitimately stop at the human-authored plan approval gate, but it
      // must never stop by telling the user to edit configuration.
      assert.doesNotMatch(JSON.stringify(result), /Edit \.paved\//i);
      assert.doesNotMatch(JSON.stringify(result), /Configure \.paved\/verification/i);
    });
  }

  it("proves the guard itself works", () => {
    const project = cleanRepository({ "README.md": "# x\n" });
    assert.throws(() => userWrite(project, ".paved/verification/profile.yaml", "x"),
      /Clean-room violation/);
    assert.throws(() => userWrite(project, ".paved/rules/quality/x.yaml", "x"),
      /Clean-room violation/);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/acceptance/no-manual-configuration.test.ts`
Expected: PASS. Any failure here is a real product gap — fix the command, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/acceptance/no-manual-configuration.test.ts
git commit -m "test: prove no manual Paved configuration is required"
```

---

### Task 28: Stack coverage and the security invariant suite

**Files:**
- Modify: `tests/adapters/runtime-stacks.test.ts`, `tests/plugins/stacks.test.ts`
- Modify: `tests/decisions/security.test.ts` (extend)

- [ ] **Step 1: Write the failing stack tests**

For each of Java + Quarkus, TypeScript + Angular, Dart, Dart + Flutter, PostgreSQL and
Git-only, assert that `init` either resolves deterministically or asks a relayed decision,
and that after answering, `status` reports no ambiguous capability provider. The Git-only
repository must raise **no** verification decision, because no check is detectable.

- [ ] **Step 2: Write the remaining security tests**

Append to `tests/decisions/security.test.ts`:

```ts
describe("security invariants an answer cannot override", () => {
  it("never lets a free-text answer become an executable argument", async () => {
    const project = projectAwaitingFreeTextDecision();
    const result = await dispatchCli({
      argv: ["test", "--project", project, "--answer", "d-0123456789abcdef0123=; rm -rf /",
        "--answered-by", "anderson@example.com", "--json"],
    });
    assert.notEqual(result.status, "success");
    assert.doesNotMatch(JSON.stringify(result), /rm -rf/);
  });

  it("refuses an answer that would authorize an unapproved ToolImplementation", async () => {
    const project = projectWithNoTestingTool();
    const result = await dispatchCli({ argv: ["test", "--project", project, "--json"] });
    assert.equal(result.decisions, undefined);
    assert.equal(result.status, "failed");
  });

  it("refuses to let an answer clear a lock integrity mismatch", async () => {
    const project = projectWithTamperedLock();
    const result = await dispatchCli({
      argv: ["update", "--project", project, "--answer", "d-0123456789abcdef0123=proceed",
        "--answered-by", "anderson@example.com", "--json"],
    });
    assert.equal(result.status, "failed");
    assert.ok(result.diagnostics.some((item) => item.code.startsWith("PAVED_LOCK_")));
  });

  it("refuses a decision id that escapes the project root", async () => {
    const project = cleanProject();
    const result = await dispatchCli({
      argv: ["decision", "show", "../../etc/passwd", "--project", project, "--json"],
    });
    assert.equal(result.status, "failed");
  });

  it("keeps secrets out of decision evidence and options", () => {
    const project = projectWithSecretInBuildFile();
    for (const candidate of verificationProvider({
      projectRoot: project, coreRoot, command: "verify", answers: [],
    })) {
      assert.doesNotMatch(JSON.stringify(candidate), /AKIA|password|secret/i);
    }
  });
});
```

- [ ] **Step 3: Implement whatever these reveal**

Every failure here is a real security gap. Fix the runtime, never the assertion.

- [ ] **Step 4: Run the suites**

Run: `node --test tests/decisions/security.test.ts tests/adapters/runtime-stacks.test.ts tests/plugins/stacks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: cover decision security invariants across runtime stacks"
```

---

### Task 29: Full gate

- [ ] **Step 1: Run the complete check**

Run: `npm run check`
Expected: typecheck clean, every test passing.

- [ ] **Step 2: Run the plugin drift check**

Run: `npm run check:plugin`
Expected: PASS.

- [ ] **Step 3: Verify the acceptance traceability table**

Walk spec §11 row by row and confirm each criterion maps to a passing test or a shipped
document. The two rows marked manual — real-repository Apecatus validation, and
question-efficiency for agent-authored questions — stay manual, as recorded in spec §10.5.

- [ ] **Step 4: Run the Apecatus manual validation**

Against a real checkout:

```bash
cd <apecatus>
node <paved>/cli/index.ts init --json
# answer the reported decisions with --answer/--answered-by
node <paved>/cli/index.ts status --json
```

Expected: `GENERATED` → `VALIDATED`/`READY`, no ambiguous capability provider, and no
manual `.paved/` editing at any point. Record the transcript in the PR description.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address findings from the full conversational decision gate"
```

---

## Self-review

**Spec coverage.** Every spec section maps to a task: §1–2 → Tasks 1–5; §3 → Tasks 6, 13;
§4 → Task 12; §5 → Tasks 7–9, 12; §6 → Tasks 5, 10, 28; §7 → Tasks 11, 14–23; §8 → Tasks
24–25; §9 → Task 26; §10 → Tasks 27–29; §11 → Task 29 Step 3; §13 → Task 5.

**Gaps found and closed during review:**

1. **Capability decision handler was referenced but never built.** Task 18 wires
   `capabilityHandler` under `"capability.select"`, and Task 16 builds the provider — but
   the handler itself had no task. It is `effect: "record-only"` (the answer stays in the
   decision record because `manifest.yaml` is human-owned), so **build it in Task 16
   Step 4** alongside `capabilityProvider`, and cover it with the round-trip test that
   step already requires.
2. **`cli/commands/decision.ts` imported a non-existent `supersedeReasonRequired`.** Fixed
   inline in Task 12 Step 3 with an explicit correction note.
3. **`plan`, `implement` and `review` have no dedicated task.** They are
   `workflowAliasHandler` delegations to `feature`/`bug`/`refactor` (`cli/runtime.ts:413`),
   so Task 21 covers them through the shared `advance` path; their agent-authored decisions
   arrive via Task 12's `decision raise`. No separate task is needed — this is a routing
   fact, not a gap.

**Type consistency.** `DecisionProjection` is defined once in `cli/result.ts` (Task 7) and
imported everywhere. `HandlerRegistration.apply` returns `readonly string[]` in Tasks 11,
15, 17 and 20. `runDecisionGate`'s input shape is identical at every call site (Tasks 15,
18, 20, 21, 22, 23). `resolveCapability`'s fourth parameter defaults to an empty map so
existing call sites compile unchanged (Task 16).

**Placeholder scan.** No `TBD`, `TODO`, "handle edge cases", or "similar to Task N".
Three steps deliberately describe a document's required content rather than its exact prose
(Tasks 24 and 26) — that is specification of deliverables, not a deferred decision.

