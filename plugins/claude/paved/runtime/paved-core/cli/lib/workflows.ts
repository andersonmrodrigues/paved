// Checks on workflows and their runs that JSON Schema cannot express: phase order,
// safe use of tools, skill orchestration without duplication, verifiable outcomes, and
// whether a run record is consistent with its workflow. Run after schema validation and
// reference resolution. See docs/concepts/workflows.md.

import {
  dependencyCycles,
  duplicatedSentences,
  genericityProblems,
  planCoverageProblems,
  saysWhenToUse,
  type EvidenceRecord,
  type SkillContract,
} from "./skills.ts";

export interface Gate {
  id: string;
  condition: string;
  when?: string;
  approval?: string;
}

/** Who does a phase's work and at which capability tier; the host maps tiers to its models. */
export interface PhaseRouting {
  mode: "primary" | "subagent" | "cli";
  capacity: "economy" | "balanced" | "frontier";
  reasoning_effort: "low" | "medium" | "high";
  rationale: string;
}

/** Host-neutral recommendations; allow is never an execution permission. */
export interface WorkflowToolPolicy {
  id: string;
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface WorkflowPhase {
  phase: string;
  goal: string;
  skills?: string[];
  tools?: { required?: string[]; optional?: string[] };
  tool_policies?: string[];
  verification?: { required?: string[]; recommended?: string[]; optional?: string[] };
  gates?: Gate[];
  skip_when?: string;
  retry?: { class: string; max_attempts?: number };
  routing?: PhaseRouting;
  fragments?: { id: string; with?: Record<string, string> }[];
}

export type AutonomyProfile = "guided" | "balanced" | "autonomous";

export interface WorkflowContract {
  id: string;
  version: string;
  status: string;
  description: string;
  change_type: string;
  autonomy?: { default_profile: AutonomyProfile };
  tool_policies?: WorkflowToolPolicy[];
  inputs: { id: string; required: boolean }[];
  rules?: string[];
  phases: WorkflowPhase[];
  evidence: { required: string[] };
  outputs: string[];
  completion: { criteria: string[] };
  references?: string[];
}

export interface WorkflowFragmentMetadata {
  apiVersion: string;
  kind: "WorkflowFragment";
  id: string;
  title: string;
  version: string;
  status: string;
  inputs: string[];
  skills: string[];
  tools: string[];
}

/** Validated metadata paired with its separate FRAGMENT.md body. */
export interface WorkflowFragmentContract {
  contract: WorkflowFragmentMetadata;
  body: string;
}

export interface ResolvedWorkflowPhase extends WorkflowPhase {
  fragments?: { id: string; with?: Record<string, string>; body: string }[];
}

export interface ResolvedWorkflowContract extends WorkflowContract {
  phases: ResolvedWorkflowPhase[];
}

/** Resolve one level of guidance; no expressions, recursive templates or host execution. */
export function resolveWorkflowFragments(
  workflow: WorkflowContract,
  fragments: ReadonlyMap<string, WorkflowFragmentContract>,
): { phases: ResolvedWorkflowPhase[]; problems: string[] } {
  const problems: string[] = [];
  const phases = workflow.phases.map((phase): ResolvedWorkflowPhase => {
    const { fragments: inclusions, ...base } = phase;
    if (inclusions === undefined) return base;
    const resolved: NonNullable<ResolvedWorkflowPhase["fragments"]> = [];
    const seen = new Set<string>();
    const skills = new Set(phase.skills ?? []);
    const requiredTools = new Set(phase.tools?.required ?? []);
    for (const inclusion of inclusions) {
      const at = `phase ${phase.phase} fragment ${inclusion.id}`;
      if (seen.has(inclusion.id)) problems.push(`${at}: duplicate fragment inclusion`);
      seen.add(inclusion.id);
      const fragment = fragments.get(inclusion.id);
      if (fragment === undefined) {
        problems.push(`${at}: unknown fragment`);
        continue;
      }
      const { contract, body } = fragment;
      if ("fragments" in contract) problems.push(`${at}: nested fragment references are not allowed`);
      const bindings = inclusion.with ?? {};
      const inputs = new Set(contract.inputs);
      for (const id of inputs) {
        if (!Object.hasOwn(bindings, id)) problems.push(`${at}: missing input ${id}`);
      }
      for (const [id, value] of Object.entries(bindings)) {
        if (!inputs.has(id)) problems.push(`${at}: unknown input ${id}`);
        if (typeof value !== "string" || value.trim().length === 0 || /\{\{|\}\}/.test(value)) {
          problems.push(`${at}: invalid value for input ${id}`);
        }
      }
      const interpolated = body.replace(/\{\{ inputs\.([a-z0-9]+(?:-[a-z0-9]+)*) \}\}/g, (placeholder, id: string) => {
        if (!inputs.has(id)) {
          problems.push(`${at}: undeclared input ${id}`);
          return placeholder;
        }
        const value = bindings[id];
        return typeof value === "string" ? value : placeholder;
      });
      if (/\{\{|\}\}/.test(interpolated)) problems.push(`${at}: unresolved placeholder`);
      resolved.push({ ...inclusion, body: interpolated });
      for (const skill of contract.skills) skills.add(skill);
      for (const tool of contract.tools) requiredTools.add(tool);
    }
    return {
      ...phase,
      fragments: resolved,
      skills: [...skills],
      tools: { ...phase.tools, required: [...requiredTools],
        ...(phase.tools?.optional === undefined ? {} : { optional: phase.tools.optional.filter((id) => !requiredTools.has(id)) }) },
    };
  });
  // Fail closed: callers cannot accidentally execute a partially interpolated phase.
  return { phases: problems.length > 0 ? [] : phases, problems };
}

export interface WorkflowFiles {
  contract: WorkflowContract;
  /** WORKFLOW.md body. */
  body: string;
}

/** What the workflow checks need to know about the rest of the effective set. */
export interface WorkflowContext {
  /** Canonical phase order (the `phase` enum of the common schema). */
  phaseOrder: readonly string[];
  skills: ReadonlyMap<string, SkillContract & { body?: string }>;
  /** Tool id → safety class. */
  toolSafety: ReadonlyMap<string, string>;
  /** Check type → claim types it can support. */
  supports: ReadonlyMap<string, string[]>;
}

export const WORKFLOW_MAX_LINES = 80;
export const SKILLS_PER_PHASE = 3;
export const DEFAULT_RETRY = { class: "retryable", max_attempts: 2 } as const;

/** The run status and retry class each failure code implies. One table; docs and records follow it. */
export const FAILURE_CODES: Readonly<Record<string, { status: "failed" | "blocked" | "awaiting-approval"; retry: string }>> = {
  "input-missing": { status: "blocked", retry: "requires-human" },
  "precondition-failed": { status: "blocked", retry: "requires-human" },
  "context-missing": { status: "blocked", retry: "requires-human" },
  "tool-unavailable": { status: "blocked", retry: "requires-human" },
  "skill-unavailable": { status: "blocked", retry: "non-retryable" },
  "rule-violation": { status: "blocked", retry: "requires-human" },
  "approval-required": { status: "awaiting-approval", retry: "requires-human" },
  "approval-rejected": { status: "blocked", retry: "non-retryable" },
  "skill-failed": { status: "failed", retry: "retryable" },
  "verification-failed": { status: "failed", retry: "retryable" },
  inconclusive: { status: "failed", retry: "retryable" },
  "evidence-insufficient": { status: "failed", retry: "retryable" },
  "retries-exhausted": { status: "failed", retry: "requires-human" },
};

// Change types whose runs act on shared or production systems, and the approval a gate
// must carry somewhere in the workflow.
const HIGH_RISK: Readonly<Record<string, string>> = { release: "release", incident: "production-change" };

const listed = (phase: WorkflowPhase) => [...(phase.tools?.required ?? []), ...(phase.tools?.optional ?? [])];

/** Required dependencies of `id`, transitively. */
function requiredClosure(id: string, skills: WorkflowContext["skills"], seen = new Set<string>()): Set<string> {
  for (const dep of skills.get(id)?.depends_on?.required ?? []) {
    if (!seen.has(dep)) {
      seen.add(dep);
      requiredClosure(dep, skills, seen);
    }
  }
  return seen;
}

const POLICY_ACTIONS = ["allow", "ask", "deny"] as const;

/** Resolve selected policies without adding phase Tools; first same-action occurrence wins. */
export function resolvePhaseToolPolicies(workflow: WorkflowContract, phase: WorkflowPhase): {
  policies: WorkflowToolPolicy[]; problems: string[];
} {
  const policies: WorkflowToolPolicy[] = [];
  const problems: string[] = [];
  const actions = new Map<string, typeof POLICY_ACTIONS[number]>();
  for (const id of phase.tool_policies ?? []) {
    const policy = workflow.tool_policies?.find((item) => item.id === id);
    if (policy === undefined) {
      problems.push(`phase ${phase.phase}: unknown tool policy ${id}`);
      continue;
    }
    const effective: WorkflowToolPolicy = { id, allow: [], ask: [], deny: [] };
    for (const action of POLICY_ACTIONS) {
      for (const tool of policy[action]) {
        const existing = actions.get(tool);
        if (existing !== undefined && existing !== action) {
          problems.push(`phase ${phase.phase}: tool ${tool} has conflicting actions ${existing} and ${action}`);
        } else if (existing === undefined) {
          effective[action].push(tool);
        }
        actions.set(tool, action);
      }
    }
    policies.push(effective);
  }
  return { policies, problems };
}

/** Problems with one workflow's structure, safety, verifiability and use of skills. */
export function assessWorkflowQuality(files: WorkflowFiles, context: WorkflowContext): string[] {
  const { contract, body } = files;
  const problems: string[] = [];
  const phases = contract.phases;

  const policyIds = new Set<string>();
  for (const policy of contract.tool_policies ?? []) {
    if (policyIds.has(policy.id)) problems.push(`duplicate tool policy ${policy.id}`);
    policyIds.add(policy.id);
    const actions = new Map<string, typeof POLICY_ACTIONS[number]>();
    for (const action of POLICY_ACTIONS) {
      for (const tool of policy[action]) {
        if (!context.toolSafety.has(tool)) problems.push(`tool policy ${policy.id}: unknown tool ${tool}`);
        const existing = actions.get(tool);
        if (existing !== undefined && existing !== action) {
          problems.push(`tool policy ${policy.id}: tool ${tool} has conflicting actions ${existing} and ${action}`);
        }
        actions.set(tool, action);
      }
    }
  }
  for (const phase of phases) {
    const selected = resolvePhaseToolPolicies(contract, phase);
    problems.push(...selected.problems);
    const denied = new Set(selected.policies.flatMap((policy) => policy.deny));
    const skills = new Set(phase.skills ?? []);
    for (const id of [...skills]) for (const dep of requiredClosure(id, context.skills)) skills.add(dep);
    const requiredTools = new Set([...(phase.tools?.required ?? []),
      ...[...skills].flatMap((id) => context.skills.get(id)?.tools?.required ?? [])]);
    for (const tool of requiredTools) {
      if (denied.has(tool)) problems.push(`phase ${phase.phase}: required tool ${tool} is denied`);
    }
  }

  const indexes = phases.map((p) => context.phaseOrder.indexOf(p.phase));
  for (let i = 1; i < indexes.length; i++) {
    if (indexes[i]! <= indexes[i - 1]!) problems.push(`phase "${phases[i]!.phase}" is out of canonical order or repeated`);
  }

  const gateIds = phases.flatMap((p) => (p.gates ?? []).map((g) => g.id));
  if (new Set(gateIds).size !== gateIds.length) problems.push("gate ids are not unique");

  if (!saysWhenToUse(contract.description)) problems.push('description does not say when to use the workflow ("Use when …")');
  problems.push(...genericityProblems("workflow", `${contract.description}\n${body}`));

  const lines = body.split("\n").length;
  if (lines > WORKFLOW_MAX_LINES) {
    problems.push(`WORKFLOW.md has ${lines} lines (limit ${WORKFLOW_MAX_LINES}); move procedure into skills`);
  }
  for (const phase of phases) {
    if ((phase.skills ?? []).length > SKILLS_PER_PHASE) {
      problems.push(`phase ${phase.phase} activates more than ${SKILLS_PER_PHASE} skills; split the work or compose skills`);
    }
  }

  // Everything the contract names directly is explained in WORKFLOW.md.
  for (const id of [...(contract.rules ?? []), ...phases.flatMap(listed), ...(contract.references ?? [])]) {
    if (!body.includes(id)) problems.push(`WORKFLOW.md never mentions ${id}, which workflow.yaml lists`);
  }

  // A software change must be proven: required checks that can prove something, and evidence.
  const changesCode = phases.some((p) => p.phase === "implementation");
  const required = phases.flatMap((p) => p.verification?.required ?? []);
  if (changesCode) {
    const verification = phases.find((p) => p.phase === "verification");
    if ((verification?.verification?.required ?? []).length === 0) {
      problems.push("the workflow changes code but its verification phase requires no check type");
    }
    if (contract.evidence.required.length === 0) problems.push("the workflow changes code but requires no evidence");
  }
  for (const type of required) {
    if ((context.supports.get(type) ?? []).length === 0) {
      problems.push(`required check type ${type} cannot prove anything; make it recommended`);
    }
  }

  // Tool safety holds through the workflow: destructive tools, used directly or by a
  // phase's skills, need a destructive-operation approval gate in that phase and no
  // automatic retry.
  for (const phase of phases) {
    const tools = [...listed(phase), ...(phase.skills ?? []).flatMap((id) => {
      const skill = context.skills.get(id);
      return [...(skill?.tools?.required ?? []), ...(skill?.tools?.optional ?? [])];
    })];
    const destructive = tools.filter((id) => context.toolSafety.get(id) === "destructive");
    if (destructive.length > 0) {
      if (!(phase.gates ?? []).some((g) => g.approval === "destructive-operation")) {
        problems.push(`phase ${phase.phase} can use destructive tools (${destructive.join(", ")}) without an approval gate ("destructive-operation")`);
      }
      if ((phase.retry ?? DEFAULT_RETRY).class === "retryable") {
        problems.push(`phase ${phase.phase} can use destructive tools but is retried automatically`);
      }
    }
  }

  const approval = HIGH_RISK[contract.change_type];
  if (approval !== undefined && !phases.some((p) => (p.gates ?? []).some((g) => g.approval === approval))) {
    problems.push(`a ${contract.change_type} workflow needs a gate with approval "${approval}"`);
  }

  // Skills are orchestrated, not duplicated: a skill already brought in as a required
  // dependency of a skill listed in the same or an earlier phase must not be listed again.
  const dependencies = new Set<string>();
  for (const phase of phases) {
    const listedSkills = phase.skills ?? [];
    const brought = new Set(listedSkills.flatMap((id) => [...requiredClosure(id, context.skills)]));
    for (const id of listedSkills) {
      if (brought.has(id) || dependencies.has(id)) {
        problems.push(`phase ${phase.phase} lists ${id}, which another listed skill already activates as a required dependency`);
      }
    }
    for (const id of brought) dependencies.add(id);
  }

  const reachable = new Set(phases.flatMap((p) => p.skills ?? []));
  for (const id of [...reachable]) for (const dep of requiredClosure(id, context.skills)) reachable.add(dep);
  for (const id of reachable) {
    if (context.skills.get(id)?.status === "deprecated") problems.push(`uses deprecated skill ${id}`);
  }
  const contracts = [...reachable].flatMap((id) => {
    const skill = context.skills.get(id);
    return skill === undefined ? [] : [skill];
  });
  problems.push(...dependencyCycles(contracts).map((cycle) => `skill dependency cycle: ${cycle}`));

  const skillTexts = contracts.flatMap((s) => (s.body === undefined ? [] : [{ id: s.id, text: s.body }]));
  problems.push(...duplicatedSentences([{ id: contract.id, text: body }, ...skillTexts]).filter((p) => p.includes(contract.id)));
  return problems;
}

export interface WorkflowRunRecord {
  autonomy_profile?: AutonomyProfile;
  workflow: { id: string; version: string };
  status: string;
  inputs: { id: string }[];
  phases: {
    phase: string;
    status: string;
    attempts?: number;
    gates?: { id: string; status: string }[];
    failure?: RunFailure;
  }[];
  decisions?: { id: string; status: string; required: boolean; handler?: string; question?: string; answer?: unknown }[];
  events?: { type: string; phase?: string; detail?: string }[];
  failure?: RunFailure;
}

export const RECOVER_HANDLER = "run.recover";
export const UNCHANGED_HANDLER = "run.unchanged";
export const AMENDED_RETRY = "plan amended";
export const REVIEW_HANDLER = "run.review";
export const REVIEW_FIX = "review findings";

export function recoveryQuestion(phase: string, attempts: number): string {
  return `The ${phase} phase failed ${attempts} times. How should Paved continue?`;
}

/** Applied "how should Paved continue?" answers for a phase, oldest first. */
export function recoveriesFor<T extends NonNullable<WorkflowRunRecord["decisions"]>[number]>(decisions: readonly T[] | undefined, phase: string): T[] {
  return (decisions ?? []).filter((decision) => decision.handler === RECOVER_HANDLER && decision.status === "APPLIED"
    && decision.question?.startsWith(`The ${phase} phase failed `) === true);
}

/**
 * Each "retry" the user chose, each approved plan amendment and each review finding sent
 * back to implementation gives a phase a fresh set of attempts on top of the workflow's limit. An "amend" answer earns its round only once
 * the amendment is approved, so it is counted there and not twice.
 */
export function attemptRounds(run: Pick<WorkflowRunRecord, "decisions" | "events">, phase: string): number {
  const amended = (run.events ?? []).filter((event) => (event.type === "retry-started" || event.type === "phase-reopened") && event.phase === phase && (event.detail === AMENDED_RETRY || event.detail === REVIEW_FIX)).length;
  return 1 + recoveriesFor(run.decisions, phase).filter((decision) => decision.answer === "retry").length + amended;
}

interface RunFailure {
  code: string;
  phase: string;
  retry: string;
}

const DONE = new Set(["completed", "skipped"]);

/** Problems with a run record measured against the workflow it claims to run. */
export function assessRun(run: WorkflowRunRecord, workflow: WorkflowContract): string[] {
  const problems: string[] = [];
  if (run.workflow.id !== workflow.id || run.workflow.version !== workflow.version) {
    problems.push(`run is for ${run.workflow.id}@${run.workflow.version}, not ${workflow.id}@${workflow.version}`);
    return problems;
  }

  const expected = workflow.phases.map((p) => p.phase);
  const actual = run.phases.map((p) => p.phase);
  if (expected.join(",") !== actual.join(",")) {
    problems.push(`run phases [${actual.join(", ")}] differ from the workflow's [${expected.join(", ")}]`);
    return problems;
  }

  const received = new Set(run.inputs.map((i) => i.id));
  const known = new Set(workflow.inputs.map((i) => i.id));
  for (const input of workflow.inputs) {
    if (input.required && !received.has(input.id) && run.phases.some((p) => p.status !== "pending")) {
      problems.push(`required input ${input.id} is missing, but phases have started`);
    }
  }
  for (const id of received) if (!known.has(id)) problems.push(`input ${id} is not declared by the workflow`);

  let running = 0;
  run.phases.forEach((record, i) => {
    const phase = workflow.phases[i]!;
    if (record.status === "running") running++;
    // No phase starts before every earlier phase is done: nothing is skipped silently.
    if (record.status !== "pending" && !run.phases.slice(0, i).every((p) => DONE.has(p.status))) {
      problems.push(`phase ${record.phase} is ${record.status} although an earlier phase is not completed or skipped`);
    }
    if (record.status === "skipped" && phase.skip_when === undefined) {
      problems.push(`phase ${record.phase} was skipped but the workflow does not allow skipping it`);
    }

    const retry = phase.retry ?? DEFAULT_RETRY;
    const limit = (retry.class === "retryable" ? (retry.max_attempts ?? DEFAULT_RETRY.max_attempts) : 1) * attemptRounds(run, record.phase);
    if ((record.attempts ?? 0) > limit && record.failure?.code !== "retries-exhausted") {
      problems.push(`phase ${record.phase} has ${record.attempts} attempts; its limit is ${limit}`);
    }

    const gates = new Map((record.gates ?? []).map((g) => [g.id, g.status]));
    for (const id of gates.keys()) {
      if (!(phase.gates ?? []).some((g) => g.id === id)) problems.push(`phase ${record.phase} records unknown gate ${id}`);
    }
    for (const gate of phase.gates ?? []) {
      const status = gates.get(gate.id);
      if (status === "passed" && gate.approval !== undefined) {
        problems.push(`gate ${gate.id} needs a human approval; "passed" does not satisfy it`);
      }
      if (status === "not-applicable" && gate.when === undefined) {
        problems.push(`gate ${gate.id} is unconditional and cannot be not-applicable`);
      }
      if (record.status === "completed") {
        // An amended plan reopens its approval while the run pauses for it.
        const amending = gate.approval !== undefined && status === "awaiting-approval" && run.status === "awaiting-approval";
        const satisfied = amending || status === "not-applicable" || status === (gate.approval === undefined ? "passed" : "approved");
        if (!satisfied) problems.push(`phase ${record.phase} is completed but gate ${gate.id} is ${status ?? "not recorded"}`);
      }
    }
    if (record.failure !== undefined) problems.push(...failureProblems(record.failure, record.phase));
  });
  if (running > 1) problems.push("more than one phase is running");

  const allDone = run.phases.every((p) => DONE.has(p.status));
  if ((run.status === "completed" || run.status === "completed-with-warnings") && !allDone) {
    problems.push(`run is ${run.status} but not every phase is completed or skipped`);
  }
  if (run.status === "running" && allDone) problems.push("run is running but every phase is done");
  if (run.status === "awaiting-approval" && !run.phases.some((p) => (p.gates ?? []).some((g) => g.status === "awaiting-approval"))) {
    problems.push("run is awaiting approval but no gate is");
  }
  const decisions = run.decisions ?? [];
  const askedRequired = decisions.filter((item) => item.required && item.status === "ASKED");
  if (run.status === "awaiting-input" && askedRequired.length === 0) {
    problems.push("run is awaiting input but no required decision is ASKED");
  }
  if (run.status === "running" && decisions.some((item) => item.required && (item.status === "ASKED" || item.status === "PENDING"))) {
    problems.push("run is running with an unanswered required decision");
  }
  if (run.failure !== undefined) {
    problems.push(...failureProblems(run.failure));
    const implied = FAILURE_CODES[run.failure.code]?.status;
    if (implied !== undefined && (run.status === "failed" || run.status === "blocked") && implied !== run.status) {
      problems.push(`failure ${run.failure.code} means the run is ${implied}, not ${run.status}`);
    }
    const phase = run.phases.find((p) => p.phase === run.failure!.phase);
    if (phase === undefined || !["failed", "blocked", "running", "pending"].includes(phase.status)) {
      problems.push(`failure names phase ${run.failure.phase}, which did not fail`);
    }
  }
  return problems;
}

function failureProblems(failure: RunFailure, phase?: string): string[] {
  const problems: string[] = [];
  const expected = FAILURE_CODES[failure.code]?.retry;
  if (expected !== undefined && failure.retry !== expected) {
    problems.push(`failure ${failure.code} is ${expected}, not ${failure.retry}`);
  }
  if (phase !== undefined && failure.phase !== phase) problems.push(`failure recorded on phase ${phase} names phase ${failure.phase}`);
  return problems;
}

/**
 * Problems with the verification plan of a record against the workflow that produced
 * it: every check type the workflow's phases require or recommend, and every evidence
 * kind it requires, is in the plan. Skill requirements are checked separately
 * (assessSkillEvidence); whether the plan was met, by evaluateCompletion.
 */
export function assessWorkflowEvidence(record: EvidenceRecord, workflow: WorkflowContract): string[] {
  if (record.producer?.workflow !== workflow.id) return [`evidence names workflow ${record.producer?.workflow ?? "(none)"}, not ${workflow.id}`];
  const all = (key: "required" | "recommended") => [...new Set(workflow.phases.flatMap((p) => p.verification?.[key] ?? []))];
  return planCoverageProblems(workflow.id, { required: all("required"), recommended: all("recommended") }, workflow.evidence.required, record.plan);
}
