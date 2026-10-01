import { loadYaml } from "./documents.ts";

// Semantic checks on an evidence record that JSON Schema cannot express, and the
// deterministic completion decision. `evaluateCompletion` recomputes, from the recorded
// observations alone, whether the task is complete and how strongly it is verified;
// `assessEvidence` rejects a record that is inconsistent or claims more than that.
// Run after schema validation; both assume a structurally valid record.
// See docs/concepts/evidence.md.

interface Support {
  supports: string[];
}

export interface EvidenceRegistry {
  checkTypes: Record<string, Support>;
  /** `selfReportable: false` marks statements (reviews, manual observations) that support nothing when the agent records them. */
  artifactKinds: Record<string, Support & { selfReportable: boolean }>;
}

export interface VerificationPolicy {
  minimum_recorder?: string;
}

/** What evaluation needs from a check definition (check.schema.yaml). */
export interface CheckDefinition {
  id: string;
  type: string;
  tool: string;
  expected?: { exit_code?: number };
  retry?: { class: string; max_attempts?: number };
  minimum_recorder?: string;
}

interface Measurement {
  direction: string;
  baseline: { value: number; spread?: number };
  current: { value: number; spread?: number };
  threshold: { max_regression: number; relative: boolean };
}

export interface CheckResult {
  id: string;
  check: string;
  type: string;
  tool: { id: string; version: string };
  status: string;
  exit_code?: number;
  reason?: string;
  summary?: string;
  execution: { recorded_by: string; revision: string; worktree_sha256?: string };
  measurement?: Measurement;
  attempts?: { status: string; summary?: string }[];
  flaky?: boolean;
  observations?: { name: string; value: string | number | boolean }[];
}

interface Artifact {
  id: string;
  kind: string;
  recorded_by: string;
  revision: string;
  check?: string;
}

export interface EvidenceRecord {
  change: { revision: string; uncommitted_changes?: boolean; worktree_sha256?: string };
  plan: { required: string[]; recommended?: string[]; optional?: string[]; evidence: string[] };
  claims: { id: string; type: string; supported_by: string[] }[];
  checks: CheckResult[];
  artifacts?: Artifact[];
  gaps?: { check_type?: string; risk?: string; accepted_by?: string }[];
  rules?: { id: string; severity: string; status: string }[];
  completion: { status: string; verification: string; criteria: { met: boolean; supported_by?: string[] }[] };
}

/** How far an observation is from the agent's own word, weakest first. */
export const STRENGTH = ["asserted", "self-observed", "independent"] as const;
export type Strength = (typeof STRENGTH)[number];

export interface CompletionEvaluation {
  status: "complete" | "incomplete" | "blocked";
  verification: "verified" | "partially-verified" | "unverified";
  /** The weakest support among the record's claims (the strongest support of each claim). */
  strength: Strength;
  /** Problems that prevent completion. */
  blocking: string[];
  /** Reported with a complete record (`completed-with-warnings`). */
  warnings: string[];
  informational: string[];
}

// Independence from the agent, lowest first.
const RECORDER_RANK = ["agent", "paved", "ci"];

export function loadEvidenceRegistry(file: string): EvidenceRegistry {
  const raw = loadYaml(file) as {
    check_types?: Record<string, { supports?: string[] }>;
    artifact_kinds?: Record<string, { supports?: string[]; self_reportable?: boolean }>;
  };
  const checkTypes = Object.entries(raw.check_types ?? {}).map(([key, value]) => [key, { supports: value.supports ?? [] }]);
  const artifactKinds = Object.entries(raw.artifact_kinds ?? {}).map(([key, value]) => [
    key,
    { supports: value.supports ?? [], selfReportable: value.self_reportable ?? true },
  ]);
  return { checkTypes: Object.fromEntries(checkTypes), artifactKinds: Object.fromEntries(artifactKinds) };
}

/** Whether a measurement is within its threshold, computed from the numbers alone. */
export function withinThreshold(m: Measurement): boolean {
  const worsening = m.direction === "lower-is-better" ? m.current.value - m.baseline.value : m.baseline.value - m.current.value;
  const limit = m.threshold.relative ? m.threshold.max_regression * Math.abs(m.baseline.value) : m.threshold.max_regression;
  return worsening <= limit;
}

/**
 * Problems that make a record untrustworthy whatever it claims: dangling references,
 * observations of another revision, results that contradict their own data, and
 * results that do not match the check definition they name.
 */
function integrityProblems(record: EvidenceRecord, definitions: ReadonlyMap<string, CheckDefinition>): string[] {
  const problems: string[] = [];
  const checks = new Map(record.checks.map((check) => [check.id, check]));
  const artifacts = new Map((record.artifacts ?? []).map((artifact) => [artifact.id, artifact]));

  const seen = new Set<string>();
  for (const id of [
    ...record.claims.map((claim) => claim.id),
    ...record.checks.map((check) => check.id),
    ...(record.artifacts ?? []).map((artifact) => artifact.id),
  ]) {
    if (seen.has(id)) problems.push(`duplicate id "${id}"`);
    seen.add(id);
  }
  for (const claim of record.claims) {
    for (const ref of claim.supported_by) {
      if (!checks.has(ref) && !artifacts.has(ref)) problems.push(`claim "${claim.id}" references unknown check or artifact "${ref}"`);
    }
  }
  record.completion.criteria.forEach((criterion, index) => {
    for (const ref of criterion.supported_by ?? []) {
      if (!seen.has(ref)) problems.push(`completion criterion ${index + 1} references unknown id "${ref}"`);
    }
  });
  for (const artifact of artifacts.values()) {
    if (artifact.check !== undefined && !checks.has(artifact.check)) {
      problems.push(`artifact "${artifact.id}" names unknown check "${artifact.check}"`);
    }
  }

  // An observation made against another revision, or another working tree, is evidence
  // about different code.
  const subject = record.change.revision;
  for (const check of checks.values()) {
    if (check.execution.revision !== subject) {
      problems.push(`check "${check.id}" ran against revision ${check.execution.revision}, not the change revision ${subject}`);
    }
    if (record.change.uncommitted_changes === true && check.execution.worktree_sha256 !== record.change.worktree_sha256) {
      problems.push(`check "${check.id}" does not record the working tree digest of the change`);
    }
  }
  for (const artifact of artifacts.values()) {
    if (artifact.revision !== subject) {
      problems.push(`artifact "${artifact.id}" was recorded against revision ${artifact.revision}, not ${subject}`);
    }
  }

  for (const check of checks.values()) {
    // Retrying never turns a failure into a pass: attempts that disagree are flaky.
    const attempts = check.attempts ?? [];
    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1]!.status;
      const verdicts = new Set(attempts.map((a) => a.status).filter((s) => s === "passed" || s === "failed"));
      if (verdicts.size > 1) {
        if (check.flaky !== true || check.status === "passed") {
          problems.push(`check "${check.id}" has attempts that both passed and failed; record it as flaky and inconclusive`);
        }
      } else if (last !== check.status) {
        problems.push(`check "${check.id}" is ${check.status}, but its last attempt was ${last}`);
      }
    }
    if (check.flaky === true && new Set(attempts.map((a) => a.status)).size < 2) {
      problems.push(`check "${check.id}" is marked flaky without disagreeing attempts`);
    }

    if (check.measurement !== undefined && (check.status === "passed" || check.status === "failed")) {
      const within = withinThreshold(check.measurement);
      if (within !== (check.status === "passed")) {
        problems.push(`check "${check.id}" is ${check.status}, but its measurement is ${within ? "within" : "beyond"} the threshold`);
      }
    }

    const definition = definitions.get(check.check);
    if (definition === undefined) {
      if (definitions.size > 0) problems.push(`check "${check.id}" names unknown check definition "${check.check}"`);
      continue;
    }
    if (definition.type !== check.type) problems.push(`check "${check.id}" is recorded as ${check.type}, but ${definition.id} is ${definition.type}`);
    if (definition.tool !== check.tool.id) problems.push(`check "${check.id}" ran ${check.tool.id}, but ${definition.id} runs ${definition.tool}`);
    const expectedCode = definition.expected?.exit_code;
    if (expectedCode !== undefined && check.exit_code !== undefined) {
      if (check.status === "passed" && check.exit_code !== expectedCode) {
        problems.push(`check "${check.id}" claims a pass with exit code ${check.exit_code}, but ${definition.id} expects ${expectedCode}`);
      } else if (check.status === "failed" && check.exit_code === expectedCode) {
        problems.push(`check "${check.id}" claims a failure with exit code ${check.exit_code}, which meets ${definition.id}'s expectation`);
      }
    }
    const limit = definition.retry === undefined || definition.retry.class === "non-retryable" ? 1 : (definition.retry.max_attempts ?? 1);
    if (Math.max(attempts.length, 1) > limit) {
      problems.push(`check "${check.id}" has ${attempts.length} attempts; ${definition.id} allows ${limit}`);
    }
  }
  return problems;
}

/**
 * The completion decision, recomputed from the record's observations and its plan:
 *
 * - blocking: integrity problems, failed or erroring checks, unsupported claims, unmet
 *   criteria, violated `error` rules, a required check type with neither a passed check
 *   nor a gap (or with an unaccepted high-risk gap), missing required evidence kinds,
 *   and checks recorded below the policy's minimum recorder;
 * - warnings: recommended types not run,
 *   inconclusive or flaky checks, violated `warning` rules, repeated identical failures;
 * - informational: optional types not run, violated `info` rules.
 *
 * `blocked` when the only blocking problems are required checks that could not run.
 */
export function evaluateCompletion(
  record: EvidenceRecord,
  registry: EvidenceRegistry,
  policy: VerificationPolicy = {},
  definitions: ReadonlyMap<string, CheckDefinition> = new Map(),
): CompletionEvaluation {
  const blocking = integrityProblems(record, definitions);
  const warnings: string[] = [];
  const informational: string[] = [];
  const checks = new Map(record.checks.map((check) => [check.id, check]));
  const artifacts = new Map((record.artifacts ?? []).map((artifact) => [artifact.id, artifact]));

  const minimumFor = (check: CheckResult) =>
    Math.max(RECORDER_RANK.indexOf(policy.minimum_recorder ?? "agent"), RECORDER_RANK.indexOf(definitions.get(check.check)?.minimum_recorder ?? "agent"));
  const independentEnough = (check: CheckResult) => RECORDER_RANK.indexOf(check.execution.recorded_by) >= minimumFor(check);
  const counts = (check: CheckResult) => check.status === "passed" && independentEnough(check);

  // Strength of one reference as support for a claim type; undefined when it supports nothing.
  const strengthOf = (ref: string, claimType: string): Strength | undefined => {
    const check = checks.get(ref);
    if (check !== undefined) {
      if (!counts(check) || !(registry.checkTypes[check.type]?.supports.includes(claimType) ?? false)) return undefined;
      return check.execution.recorded_by === "agent" ? "self-observed" : "independent";
    }
    const artifact = artifacts.get(ref);
    const kind = artifact === undefined ? undefined : registry.artifactKinds[artifact.kind];
    if (artifact === undefined || kind === undefined || !kind.supports.includes(claimType)) return undefined;
    // An agent's own review or description is an assertion, not an observation.
    if (artifact.recorded_by === "agent") return kind.selfReportable ? "self-observed" : undefined;
    return "independent";
  };

  let strength: Strength = "independent";
  for (const claim of record.claims) {
    const found = claim.supported_by.map((ref) => strengthOf(ref, claim.type)).filter((s) => s !== undefined);
    if (found.length === 0) {
      blocking.push(`claim "${claim.id}" (${claim.type}) has no passed check or independently recorded artifact able to support a ${claim.type} claim`);
      strength = "asserted";
      continue;
    }
    const best = STRENGTH[Math.max(...found.map((s) => STRENGTH.indexOf(s)))]!;
    if (STRENGTH.indexOf(best) < STRENGTH.indexOf(strength)) strength = best;
  }

  for (const check of checks.values()) {
    if (check.status === "failed" || check.status === "error") blocking.push(`check "${check.id}" ${check.status}: ${check.summary ?? "no summary"}`);
    if (check.status === "inconclusive") warnings.push(`check "${check.id}" is inconclusive${check.flaky === true ? " (flaky)" : ""}`);
    if (check.status === "passed" && !independentEnough(check)) {
      blocking.push(`check "${check.id}" was recorded by ${check.execution.recorded_by}; ${RECORDER_RANK[minimumFor(check)]} or stronger is required`);
    }
    const failures = (check.attempts ?? []).filter((a) => a.status === "failed").map((a) => a.summary ?? "");
    if (failures.length > 1 && new Set(failures).size === 1) {
      warnings.push(`check "${check.id}" failed the same way ${failures.length} times; stop retrying and use the gardener skill or ask a human`);
    }
  }
  record.completion.criteria.forEach((criterion, index) => {
    if (!criterion.met) blocking.push(`completion criterion ${index + 1} is not met`);
  });
  for (const rule of record.rules ?? []) {
    if (rule.status !== "violated") continue;
    const message = `rule ${rule.id} is violated`;
    if (rule.severity === "error") blocking.push(message);
    else if (rule.severity === "warning") warnings.push(message);
    else informational.push(message);
  }

  const passedTypes = new Set(record.checks.filter(counts).map((c) => c.type));
  const gaps = record.gaps ?? [];
  let passedRequired = 0;
  let gapRequired = 0;
  for (const type of record.plan.required) {
    if (passedTypes.has(type)) {
      passedRequired++;
      continue;
    }
    const gap = gaps.find((g) => g.check_type === type);
    const blocked = record.checks.find((c) => c.type === type && c.status === "blocked");
    if (gap !== undefined && !(gap.risk === "high" && gap.accepted_by === undefined)) {
      gapRequired++;
      blocking.push(`required ${type} verification was not performed (gap)`);
    } else if (gap !== undefined) {
      blocking.push(`required ${type} verification is a high-risk gap nobody accepted`);
    } else if (blocked !== undefined) {
      blocking.push(`required ${type} check "${blocked.id}" is blocked: ${blocked.reason ?? "precondition unmet"}`);
    } else {
      blocking.push(`required ${type} verification has neither a passed check nor a recorded gap`);
    }
  }
  for (const type of record.plan.recommended ?? []) {
    if (!passedTypes.has(type)) warnings.push(`recommended ${type} verification was not performed`);
  }
  for (const type of record.plan.optional ?? []) {
    if (!passedTypes.has(type)) informational.push(`optional ${type} verification was not performed`);
  }
  for (const kind of record.plan.evidence) {
    const present = kind === "check-result" ? record.checks.length > 0 : (record.artifacts ?? []).some((a) => a.kind === kind);
    if (!present) {
      blocking.push(`the plan requires ${kind} evidence, and the record has none`);
    }
  }

  const required = record.plan.required.length;
  const verification =
    passedRequired === required ? "verified" : passedRequired > 0 ? "partially-verified" : "unverified";
  if (required > 0 && gapRequired === required) {
    blocking.push("no required check type passed; the record is unverified");
  }

  // Blocked means waiting on something only others can supply: every blocking problem
  // is a required check that could not run.
  const onlyBlockedChecks = blocking.length > 0 && blocking.every((p) => p.includes(" is blocked: "));
  const status = blocking.length === 0 ? "complete" : onlyBlockedChecks ? "blocked" : "incomplete";
  return { status, verification, strength, blocking, warnings, informational };
}

/**
 * Problems with a record: integrity problems always, and when it states more than
 * `evaluateCompletion` grants (a `complete` status or a verification level the
 * observations do not support), the reasons.
 */
export function assessEvidence(
  record: EvidenceRecord,
  registry: EvidenceRegistry,
  policy: VerificationPolicy = {},
  definitions: ReadonlyMap<string, CheckDefinition> = new Map(),
): string[] {
  const evaluation = evaluateCompletion(record, registry, policy, definitions);
  const problems = integrityProblems(record, definitions);
  if (record.completion.status === "complete" && evaluation.status !== "complete") {
    problems.push(...evaluation.blocking.filter((p) => !problems.includes(p)));
  }
  const rank = ["unverified", "partially-verified", "verified"];
  if (rank.indexOf(record.completion.verification) > rank.indexOf(evaluation.verification)) {
    problems.push(`the record states ${record.completion.verification}, but its observations support ${evaluation.verification}`);
  }
  return problems;
}
