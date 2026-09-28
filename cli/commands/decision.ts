import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { AGENT_ASSIGNABLE_EFFECTS, tierFor, type EffectClass } from "../lib/decisions/effects.ts";
import { fingerprintOf } from "../lib/decisions/fingerprint.ts";
import { toProjection } from "../lib/decisions/gate.ts";
import { decisionId, transition, type Decision } from "../lib/decisions/record.ts";
import { listDecisions, readDecision, writeDecision } from "../lib/decisions/store.ts";
import { acquireConsumerOperationLock } from "../lib/operation-lock.ts";

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
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail("PAVED_DECISION_INVALID_JSON", "--decision must be a JSON object.", "Pass a JSON object matching the Decision raise contract.");
  }

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
  if (run !== undefined) {
    return fail("PAVED_DECISION_RUN_SCOPE_UNAVAILABLE", "Run-scoped decisions require the WorkflowRun decision store.", "Raise this question after run-scoped decision support is available.");
  }
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
    const existing = readDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, decision.id);
    if (existing !== undefined) {
      if (existing.status === "SUPERSEDED" || existing.fingerprint.sha256 !== decision.fingerprint.sha256) {
        return fail("PAVED_DECISION_ALREADY_EXISTS", `Decision ${decision.id} already exists with different state or evidence.`, "Raise a new question or revise the existing decision.");
      }
      return createResult({ command: "decision", status: "success", data: { id: existing.id } });
    }
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
    const decisions = listDecisions(invocation.paths.projectRoot, invocation.paths.coreRoot);
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
    const decision = readDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, target);
    if (decision === undefined) return fail("PAVED_DECISION_UNKNOWN", `Unknown decision: ${target}.`, "Run paved decision list --json.");
    return createResult({ command: "decision", status: "success", data: { decision } });
  }

  if (operation === "revise") {
    if (target === undefined) return fail("PAVED_DECISION_USAGE", "revise requires a decision id.", "Use paved decision revise <id> --reason <text>.");
    const reason = invocation.flags.note?.trim();
    if (!reason) return fail("PAVED_DECISION_REASON_REQUIRED", "revise requires --reason.", "Explain why the decision is being revised.");
    const decision = readDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, target);
    if (decision === undefined) return fail("PAVED_DECISION_UNKNOWN", `Unknown decision: ${target}.`, "Run paved decision list --json.");
    if (decision.status === "SUPERSEDED" || decision.status === "CANCELLED" || decision.status === "REJECTED") {
      return fail("PAVED_DECISION_NOT_REVISABLE", `Decision ${target} cannot be revised from ${decision.status}.`, "Choose an active decision.");
    }
    const successorId = decisionId(decision.question, `revision:${decision.id}`, [reason]);
    const successor: Decision = {
      apiVersion: "paved/v1", kind: "Decision", id: successorId,
      scope: decision.scope, command: decision.command,
      ...(decision.run === undefined ? {} : { run: decision.run }),
      category: decision.category, authored_by: decision.authored_by,
      question: decision.question, reason: decision.reason,
      options: decision.options,
      ...(decision.recommended_option === undefined ? {} : { recommended_option: decision.recommended_option }),
      evidence: decision.evidence, required: decision.required,
      required_answer: decision.required_answer,
      risk: decision.risk, reversibility: decision.reversibility,
      answer_channel: decision.answer_channel,
      ...(decision.effect === undefined ? {} : { effect: decision.effect }),
      ...(decision.handler === undefined ? {} : { handler: decision.handler }),
      ...(decision.depends_on === undefined ? {} : { depends_on: decision.depends_on }),
      status: "PENDING", fingerprint: decision.fingerprint,
      supersedes: decision.id, created_at: new Date().toISOString(),
    };
    const revised = transition(decision, "SUPERSEDED", { superseded_by: successorId, superseded_reason: reason });
    const release = acquireConsumerOperationLock(invocation.paths.projectRoot, "decision:revise");
    try {
      writeDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, successor);
      writeDecision(invocation.paths.projectRoot, invocation.paths.coreRoot, revised);
    } finally {
      release();
    }
    return createResult({ command: "decision", status: "success", data: { id: revised.id, status: revised.status, successorId } });
  }

  return fail("PAVED_DECISION_USAGE", `Unknown decision operation: ${operation}.`, "Use raise, list, show or revise.");
}
