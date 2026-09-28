import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decisionId } from "../../cli/lib/decisions/record.ts";
import { decisionDigest } from "../../cli/lib/decisions/approval.ts";
import { readDecision } from "../../cli/lib/decisions/store.ts";
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

  it("uses the registered handler effect when a candidate understates it", () => {
    const project = workspace();
    const handlers = new Map<string, HandlerRegistration>([
      ["verification.adopt", { effect: "destructive", apply: () => [] }],
    ]);
    const outcome = runDecisionGate({
      context: context(project), providers: [() => [candidate({ effect: "record-only" })]],
      handlers, persist: true,
    });
    assert.equal(outcome.projections[0]?.answerChannel, "human-authored");
    assert.equal(outcome.projections[0]?.risk, "high");
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
    assert.notEqual(outcome.projections[0]?.id, id, "the successor needs a distinct audit id");
    assert.equal(readDecision(project, coreRoot, id)?.status, "SUPERSEDED");
  });

  it("rejects a relayed answer that differs from the human approval", () => {
    const project = workspace();
    const handlers = new Map<string, HandlerRegistration>([
      ["verification.adopt", { effect: "destructive", apply: () => [".paved/verification/profile.yaml"] }],
    ]);
    const provider = () => [candidate({ effect: "destructive" })];
    const first = runDecisionGate({ context: context(project), providers: [provider], handlers, persist: true });
    const id = first.projections[0]!.id;
    const decision = readDecision(project, coreRoot, id)!;
    mkdirSync(join(project, ".paved/approvals"), { recursive: true });
    writeFileSync(join(project, `.paved/approvals/${id}.json`), JSON.stringify({
      decision: id, decision_sha256: decisionDigest(decision), answer: "none",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    }));
    const outcome = runDecisionGate({
      context: context(project, { answers: [`${id}=all`], answeredBy: "anderson@example.com" }),
      providers: [provider], handlers, persist: true,
    });
    assert.ok(outcome.problems.length > 0);
    assert.equal(readDecision(project, coreRoot, id)?.status, "ASKED");
  });

  it("persists the handler key for crash recovery", () => {
    const project = workspace();
    const first = runDecisionGate({
      context: context(project), providers: [() => [candidate()]],
      handlers: new Map(), persist: true,
    });
    assert.equal(readDecision(project, coreRoot, first.projections[0]!.id)?.handler, "verification.adopt");
  });

  it("does not accept an answer before a dependent decision is asked", () => {
    const project = workspace();
    const prerequisite = decisionId("Adopt checks?", "project:verify", ["a"]);
    const dependent = decisionId("Which scope?", "project:verify", ["b"]);
    const outcome = runDecisionGate({
      context: context(project, { answers: [`${dependent}=all`], answeredBy: "anderson@example.com" }),
      providers: [() => [
        candidate({ question: "Adopt checks?", candidates: ["a"] }),
        candidate({ question: "Which scope?", candidates: ["b"], dependsOn: [prerequisite] }),
      ]], handlers: new Map(), persist: true,
    });
    assert.ok(outcome.problems.length > 0);
    assert.equal(readDecision(project, coreRoot, dependent)?.status, "PENDING");
  });

  it("keeps the question open when no apply handler is registered", () => {
    const project = workspace();
    const id = decisionId("Adopt the detected checks?", "project:verify", ["mvn-validate", "mvn-test"]);
    const outcome = runDecisionGate({
      context: context(project, { answers: [`${id}=all`], answeredBy: "anderson@example.com" }),
      providers: [() => [candidate()]], handlers: new Map(), persist: true,
    });
    assert.ok(outcome.problems.length > 0);
    assert.equal(readDecision(project, coreRoot, id)?.status, "ASKED");
  });

  it("does not reuse a superseded id on the next invocation", () => {
    const project = workspace();
    const initial = runDecisionGate({
      context: context(project), providers: [() => [candidate()]],
      handlers: new Map(), persist: true,
    });
    const changed = candidate({ evidence: [{ type: "file", location: "pom.xml", sha256: "b".repeat(64) }] });
    const second = runDecisionGate({
      context: context(project), providers: [() => [changed]],
      handlers: new Map(), persist: true,
    });
    const third = runDecisionGate({
      context: context(project), providers: [() => [changed]],
      handlers: new Map(), persist: true,
    });
    assert.notEqual(second.projections[0]?.id, initial.projections[0]?.id);
    assert.equal(third.projections[0]?.id, second.projections[0]?.id);
  });

  it("refuses an old answer after the evidence changes", () => {
    const project = workspace();
    const handlers = new Map<string, HandlerRegistration>([
      ["verification.adopt", { effect: "config-additive", apply: () => [] }],
    ]);
    const first = runDecisionGate({
      context: context(project), providers: [() => [candidate()]], handlers, persist: true,
    });
    const oldId = first.projections[0]!.id;
    const changed = candidate({ evidence: [{ type: "file", location: "pom.xml", sha256: "b".repeat(64) }] });
    const outcome = runDecisionGate({
      context: context(project, { answers: [`${oldId}=all`], answeredBy: "anderson@example.com" }),
      providers: [() => [changed]], handlers, persist: true,
    });
    assert.ok(outcome.problems.length > 0);
    assert.equal(readDecision(project, coreRoot, oldId)?.status, "SUPERSEDED");
    assert.equal(outcome.applied.length, 0);
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
