import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { assessEvidence, coveredTypes, loadEvidenceRegistry, type EvidenceRecord } from "./evidence.ts";
import { loadYaml } from "./documents.ts";
import { createRegistry, type SchemaRegistry } from "./schemas.ts";
import { isTestingToolEvidence } from "./test-runner.ts";
import { REVIEW_HANDLER } from "./workflows.ts";
import type { Run } from "./workflow-runs.ts";

export type KnowledgeState = "observed" | "documented" | "enforced" | "inferred" | "unknown";
export type ProposalStatus = "DETECTED" | "CANDIDATE" | "UNDER_REVIEW" | "ACCEPTED" | "IMPLEMENTED" | "REJECTED" | "SUPERSEDED" | "DEFERRED";
export type PreventionLayer = "architecture" | "static-analysis" | "rule" | "skill" | "workflow" | "tool" | "verification" | "human-review";
export interface GardenerObservation {
  apiVersion: "paved/v1"; kind: "GardenerObservation"; id: string; consumer: string;
  category: "verification-failure" | "rule-violation" | "missing-verification" | "generator-conflict" | "generator-unknown" | "implementation-pattern" | "correction";
  subject: string; state: KnowledgeState; pattern: string; first_observed: string; last_observed: string;
  occurrences: number; evidence: { record: string; item: string; revision?: string }[];
  provenance: { sources: { type: "file"; location: string; sha256: string }[] };
  confidence: "high" | "medium" | "low" | "unknown";
}
export interface GardenerProposal {
  apiVersion: "paved/v1"; kind: "GardenerProposal"; id: string; scope: { consumer: string; target: "consumer" };
  status: ProposalStatus; problem: string; observation: string; evidence: GardenerObservation["evidence"]; evidence_sha256: string;
  root_cause: string; root_cause_state: "inferred" | "unknown";
  recommended_layer: PreventionLayer; layer_rationale: string; proposed_change: string;
  expected_impact: string; affected_components: string[]; uncertainty: string;
  provenance: GardenerObservation["provenance"];
  related_observations?: string[];
  rule_enforcement?: RuleEnforcement;
  adoption_requirement?: { condition: "fails-on-recorded-mistake"; statement: string; reproduces: GardenerObservation["evidence"] };
  review?: { by: string; at: string; reason: string; superseded_by?: string };
}
export type EnforcementMechanism = "automated" | "agent" | "review";
export type RuleLayer = "architecture" | "static-analysis" | "ci" | "rule" | "skill" | "documentation";
export interface RuleEnforcement { rule: string; mechanism: EnforcementMechanism; layer?: RuleLayer; promotion_candidate?: boolean }
/** An evidence or run record left out of the analysis because it contradicts its own observations. */
export interface SkippedEvidence { record: string; problems: string[] }
export interface GardenerResult { consumer: string; observations: GardenerObservation[]; proposals: GardenerProposal[]; skipped: SkippedEvidence[] }
export interface CoreImprovementCandidate {
  apiVersion: "paved/v1"; kind: "CoreImprovementCandidate"; id: string; status: "CANDIDATE";
  pattern: string; consumers: string[];
  observations: { consumer: string; observation: string; evidence: GardenerObservation["evidence"] }[];
  generality: "unknown"; technology_independence: "unknown"; approval_required: true;
  problem: string; uncertainty: string;
}

export class GardenerInputError extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (prefix: string, value: string) => `${prefix}-${hash(value).slice(0, 20)}`;
const posix = (value: string) => value.split(sep).join("/");

interface Incident { category: GardenerObservation["category"]; subject: string; pattern: string; state: KnowledgeState; at: string; record: string; item: string; revision?: string; sourceHash: string }
interface ReviewRecord { proposal: string; status: Exclude<ProposalStatus, "DETECTED" | "CANDIDATE">; by: string; at: string; reason: string; evidence_sha256: string; superseded_by?: string }

function files(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => join(dir, entry.name)).sort();
}

function readValidated(path: string, coreRoot: string): { raw: string; value: unknown } {
  const raw = readFileSync(path, "utf8");
  let value: unknown;
  try { value = parse(raw); } catch { throw new GardenerInputError("Invalid Gardener input YAML."); }
  const result = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(value);
  if (!result.valid) throw new GardenerInputError(`Invalid Gardener input: ${result.errors.join("; ")}`);
  return { raw, value };
}

function reviews(projectRoot: string, coreRoot: string): Map<string, ReviewRecord> {
  const path = join(projectRoot, ".paved/gardener/reviews.yaml");
  if (!existsSync(path)) return new Map();
  const { value } = readValidated(path, coreRoot);
  const doc = value as { reviews: ReviewRecord[] };
  const latest = new Map<string, ReviewRecord>();
  for (const record of doc.reviews) {
    const previous = latest.get(record.proposal)?.status ?? "CANDIDATE";
    const allowed: Record<string, string[]> = {
      CANDIDATE: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "DEFERRED"],
      UNDER_REVIEW: ["ACCEPTED", "REJECTED", "DEFERRED", "SUPERSEDED"],
      ACCEPTED: ["IMPLEMENTED", "DEFERRED", "SUPERSEDED"],
      DEFERRED: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "SUPERSEDED"],
      REJECTED: ["UNDER_REVIEW", "SUPERSEDED"],
      IMPLEMENTED: [], SUPERSEDED: [],
    };
    if (!allowed[previous]?.includes(record.status)) throw new GardenerInputError(`Invalid Gardener review transition ${previous} -> ${record.status}.`);
    latest.set(record.proposal, record);
  }
  return latest;
}

function evidenceIncidents(projectRoot: string, coreRoot: string, skipped: SkippedEvidence[]): Incident[] {
  const found: Incident[] = [];
  const paths = [
    ...files(join(projectRoot, ".paved/generated/evidence"), ".yaml"),
    ...files(join(projectRoot, ".paved/verification/evidence"), ".yaml"),
  ];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const { raw, value } = readValidated(path, coreRoot);
    const record = value as EvidenceRecord & { id: string; created_at: string };
    const rel = posix(relative(projectRoot, path));
    // One self-contradicting record must not hide what every other record shows.
    const problems = assessEvidence(record, loadEvidenceRegistry(join(coreRoot, "core/verification/registry.yaml")));
    if (problems.length > 0) { skipped.push({ record: rel, problems }); continue; }
    // A retained copy and its disposable original represent one run.
    const recordHash = hash(JSON.stringify(record));
    const previous = seen.get(record.id);
    if (previous !== undefined) {
      if (previous !== recordHash) throw new GardenerInputError(`Evidence id ${record.id} has conflicting record contents in ${rel}.`);
      continue;
    }
    seen.set(record.id, recordHash);
    const base = { at: record.created_at, record: rel, revision: record.change.revision, sourceHash: hash(raw) };
    for (const check of record.checks) {
      for (const fact of check.observations ?? []) {
        if (fact.name !== "implementation-pattern" || typeof fact.value !== "string") continue;
        const fingerprint = hash(fact.value);
        found.push({ ...base, category: "implementation-pattern", subject: check.check,
          pattern: `implementation:${check.check}:${fingerprint}`, state: "observed", item: `${check.id}:${fingerprint.slice(0, 20)}` });
      }
      if (check.status !== "failed" && check.status !== "error") continue;
      found.push({ ...base, category: "verification-failure", subject: check.check, pattern: `check:${check.check}:${check.status}`, state: "enforced", item: check.id });
    }
    for (const rule of record.rules ?? []) {
      if (rule.status !== "violated") continue;
      found.push({ ...base, category: "rule-violation", subject: rule.id, pattern: `rule:${rule.id}`, state: "documented", item: rule.id });
    }
    // A testing Tool log never claims verification, so its uncovered plan is not an omission.
    for (const type of isTestingToolEvidence(record) ? [] : record.plan.required) {
      const covering = record.checks.filter((check) => coveredTypes(check).includes(type));
      if (covering.some((check) => ["passed", "failed", "error"].includes(check.status))) continue;
      found.push({ ...base, category: "missing-verification", subject: type, pattern: `missing:${type}`, state: "documented", item: type });
    }
  }
  return found;
}

function generatorIncidents(projectRoot: string): Incident[] {
  const path = join(projectRoot, ".paved/generated/state/last-run.json");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  let run: { timestamp?: string; executions?: { generator?: string; status?: string; unknowns?: string[] }[] };
  try { run = JSON.parse(raw) as typeof run; } catch { throw new GardenerInputError("Invalid generator last-run state."); }
  const rel = posix(relative(projectRoot, path));
  return (run.executions ?? []).flatMap((entry) => {
    if (typeof entry.generator !== "string") return [];
    const base = { subject: entry.generator, at: run.timestamp ?? "unknown", record: rel, sourceHash: hash(raw) };
    return [
      ...(entry.status === "conflict" ? [{ ...base, category: "generator-conflict" as const, pattern: `generator:${entry.generator}`, state: "observed" as const, item: entry.generator }] : []),
      ...(entry.unknowns ?? []).map((unknown) => ({ ...base, category: "generator-unknown" as const,
        pattern: `generator-unknown:${entry.generator}:${hash(unknown)}`, state: "unknown" as const, item: hash(unknown).slice(0, 20) })),
    ];
  });
}

const RULE_REF = /^(core|project|adapter-[a-z0-9]+(-[a-z0-9]+)*)(\.[a-z0-9]+(-[a-z0-9]+)*){2}$/;
const FIXED_REVIEW = /(?:^|; )blocking=\d+ \(fix\)(?:;|$)/;

/**
 * Human corrections Paved already records in workflow runs: a plan a person rejected and
 * blocking review findings a person sent back to implementation. Runs written by an older
 * workflow version still count, so they are checked against the schema only.
 */
function correctionIncidents(projectRoot: string, registry: SchemaRegistry, skipped: SkippedEvidence[]): Incident[] {
  const found: Incident[] = [];
  for (const path of files(join(projectRoot, ".paved/generated/runs"), ".yaml")) {
    const rel = posix(relative(projectRoot, path));
    const raw = readFileSync(path, "utf8");
    let value: unknown;
    try { value = parse(raw); } catch { skipped.push({ record: rel, problems: ["the run record is not valid YAML"] }); continue; }
    const validation = registry.validate(value);
    if (!validation.valid) { skipped.push({ record: rel, problems: validation.errors }); continue; }
    const run = value as Run;
    const workflow = run.workflow?.id;
    if (workflow === undefined) continue;
    const base = { category: "correction" as const, state: "documented" as const, record: rel, revision: run.revision, sourceHash: hash(raw) };
    const rejected = run.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.id === "plan-approved" && gate.status === "rejected");
    if (rejected) {
      found.push({ ...base, subject: workflow, pattern: `correction:plan-rejected:${workflow}`, at: rejected.decided_at ?? run.started_at, item: `${run.id}:plan-rejected` });
    }
    for (const decision of run.decisions ?? []) {
      if (decision.handler !== REVIEW_HANDLER || decision.status !== "APPLIED" || decision.answer !== "fix") continue;
      found.push({ ...base, subject: workflow, pattern: `correction:review-fix:${workflow}`, at: decision.answered_at ?? run.started_at, item: decision.id });
    }
    // The next review overwrites the findings file, so the rules a fix concerned come from the run's own event.
    for (const event of run.events ?? []) {
      const detail = event.detail ?? "";
      if (event.type !== "evidence-recorded" || event.phase !== "review" || !FIXED_REVIEW.test(detail)) continue;
      const digest = /(?:^|; )sha256=([a-f0-9]{64})/.exec(detail)?.[1];
      if (digest === undefined) continue;
      const rules = /(?:^|; )rules=([^;]+)/.exec(detail)?.[1]?.split(",").filter((rule) => RULE_REF.test(rule)) ?? [];
      for (const rule of new Set(rules)) {
        found.push({ ...base, subject: rule, pattern: `correction:rule:${rule}`, at: event.at, item: `review-fix:${digest.slice(0, 20)}` });
      }
    }
  }
  return found;
}

const MECHANISMS: ReadonlySet<unknown> = new Set(["automated", "agent", "review"]);
const RULE_LAYERS: ReadonlySet<unknown> = new Set(["architecture", "static-analysis", "ci", "rule", "skill", "documentation"]);

/** Enforcement of every Core, adapter and project rule by id; an unreadable definition is simply not known. */
function ruleEnforcement(projectRoot: string, coreRoot: string): Map<string, Omit<RuleEnforcement, "rule">> {
  const rules = new Map<string, Omit<RuleEnforcement, "rule">>();
  const walk = (dir: string, inRules: boolean): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, inRules || entry.name === "rules"); continue; }
      if (!inRules || !entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      let doc: { kind?: unknown; id?: unknown; enforcement?: { mechanism?: unknown; layer?: unknown } } | null;
      try { doc = loadYaml(path) as typeof doc; } catch { continue; }
      const mechanism = doc?.enforcement?.mechanism;
      if (doc?.kind !== "Rule" || typeof doc.id !== "string" || !MECHANISMS.has(mechanism)) continue;
      const layer = doc.enforcement?.layer;
      rules.set(doc.id, { mechanism: mechanism as EnforcementMechanism, ...(RULE_LAYERS.has(layer) ? { layer: layer as RuleLayer } : {}) });
    }
  };
  walk(join(coreRoot, "core/rules"), true);
  walk(join(coreRoot, "adapters"), false);
  walk(join(projectRoot, ".paved/rules"), true);
  return rules;
}

const PROBLEM_LABELS: Readonly<Record<string, string>> = {
  "missing-verification": "Required verification type with no passing or failing check:",
  "verification-failure": "Failing check",
  "rule-violation": "Violated rule",
  "generator-conflict": "Conflicting generator output from",
  "generator-unknown": "Unresolved project fact reported by",
  "implementation-pattern": "Implementation pattern in",
};
const CORRECTION_LABELS: Readonly<Record<string, string>> = {
  "plan-rejected": "Plan rejected by a person in workflow",
  "review-fix": "Blocking review findings a person sent back to implementation in workflow",
};
const correctionKind = (pattern: string): string => pattern.split(":")[1] ?? "";

type Diagnosis = Pick<GardenerProposal, "root_cause" | "root_cause_state" | "recommended_layer" | "layer_rationale" | "proposed_change" | "expected_impact" | "uncertainty">;

function diagnosis(observation: GardenerObservation): Diagnosis {
  if (observation.category === "correction") return {
    root_cause: "A person corrected the agent's work in this workflow more than once; the records do not say what the mistakes had in common.", root_cause_state: "unknown",
    recommended_layer: "human-review", layer_rationale: "The run records show the correction but not its content; a person must name the recurring mistake before a layer can be chosen.",
    proposed_change: `Compare the cited ${correctionKind(observation.pattern) === "plan-rejected" ? "rejected plans" : "review findings"} in ${observation.subject} runs, name the recurring mistake, and propose it as a rule or check at the strongest layer that holds it.`,
    expected_impact: "A recurring correction becomes an enforced constraint instead of a repeated conversation.",
    uncertainty: "The corrections may be unrelated; recurrence in one workflow does not establish a shared cause.",
  };
  if (observation.category === "missing-verification") return {
    root_cause: "The required check was not recorded as passed; the reason for omission is unknown.", root_cause_state: "unknown",
    recommended_layer: "workflow", layer_rationale: "A recurring omitted step is best addressed at the task completion gate; review whether verification already blocks completion.",
    proposed_change: `Review the workflow gate for required ${observation.subject} verification and close any bypass.`, expected_impact: "Tasks cannot be marked complete without the required evidence.",
    uncertainty: "The evidence does not establish why the step was missed or whether a workflow change is necessary.",
  };
  if (observation.category === "generator-conflict") return {
    root_cause: "Generated output and its regeneration baseline conflict; the reason for the edits is unknown.", root_cause_state: "inferred",
    recommended_layer: "tool", layer_rationale: "The generator ownership and merge contract is the strongest existing prevention point.",
    proposed_change: `Review ${observation.subject} ownership metadata and safe regeneration behavior.`, expected_impact: "Fewer regeneration conflicts without overwriting human edits.",
    uncertainty: "Human intent behind conflicting edits has not been established.",
  };
  if (observation.category === "generator-unknown") return {
    root_cause: "A generator repeatedly could not establish a project fact; the missing authority is unknown.", root_cause_state: "unknown",
    recommended_layer: "human-review", layer_rationale: "Unknown project intent requires a human source before any engineering mechanism can be chosen.",
    proposed_change: `Review the unknown reported by ${observation.subject} and document the intended project fact if appropriate.`,
    expected_impact: "Project context can cite an authoritative source.", uncertainty: "The Gardener cannot infer the desired state from repository repetition.",
  };
  if (observation.category === "rule-violation") return ruleDiagnosis(observation.subject);
  return {
    root_cause: "The configured check repeatedly fails; the underlying engineering cause is unknown.", root_cause_state: "unknown",
    recommended_layer: "architecture", layer_rationale: "Review whether design can prevent the failure before adding another instruction or check.",
    proposed_change: `Investigate ${observation.subject} failures and consider a structural fix before weaker guidance.`, expected_impact: "Prevent recurrence if the root cause is structural.",
    uncertainty: "Check failure alone does not establish architectural intent or a particular fix.",
  };
}

function ruleDiagnosis(rule: string): Diagnosis {
  return {
    root_cause: "The rule is documented but violations recur; the underlying design cause is unknown.", root_cause_state: "unknown",
    recommended_layer: "static-analysis", layer_rationale: "A deterministic recurring rule violation may be preventable by an automated check; review structural detectability first.",
    proposed_change: `Assess whether ${rule} can be checked structurally; otherwise improve the existing rule.`, expected_impact: "Earlier detection of the same violation.",
    uncertainty: "The record does not prove that static analysis can detect this rule.",
  };
}

const ENFORCED_BY: Readonly<Record<string, string>> = { agent: "the agent's own self-check", review: "a human reviewer's judgement" };
// The next stronger layer for a rule already held at one: architecture > static-analysis > verification > documentation.
const STRONGER: Readonly<Partial<Record<RuleLayer, PreventionLayer>>> = { "static-analysis": "architecture", architecture: "human-review" };

/** A rule that only the agent or a reviewer enforces, and that keeps being broken, is a candidate for a stronger layer. */
function promotionDiagnosis(rule: string, enforcement: Omit<RuleEnforcement, "rule">): Diagnosis {
  const recommended = STRONGER[enforcement.layer ?? "documentation"] ?? "static-analysis";
  return {
    root_cause: `${rule} relies on ${ENFORCED_BY[enforcement.mechanism]}, and the recorded mistakes passed it; the design cause is unknown.`, root_cause_state: "unknown",
    recommended_layer: recommended,
    layer_rationale: `${rule} is enforced only by ${ENFORCED_BY[enforcement.mechanism]}${enforcement.layer ? ` at layer ${enforcement.layer}` : ""}. Promote it to the strongest layer that can hold it, in order: architecture, static analysis (types, lint, architecture tests), a test or CI check, and only then documentation.`,
    proposed_change: recommended === "human-review"
      ? `Review why ${rule} is still broken although its layer is ${enforcement.layer}, and whether the design really prevents the recorded mistake.`
      : `Promote ${rule}: make the recorded mistake unrepresentable or detect it with a static check; if neither fits, add a test or CI check. Then set the rule's enforcement to automated with that check.`,
    expected_impact: "The recorded mistake is caught by a mechanism before review, for agents and humans alike.",
    uncertainty: "The records do not show that a deterministic check can detect this rule, or that every recorded case shares one cause.",
  };
}

const CHECK_LAYERS: ReadonlySet<PreventionLayer> = new Set(["architecture", "static-analysis", "verification"]);
const ADOPTION_STATEMENT = "Before adoption, show the proposed check or structural change failing on a fixture that reproduces one of the recorded mistakes cited here, then passing once that mistake is corrected. A check never seen failing on a recorded mistake is not evidence that it prevents it.";

function problemFor(observation: GardenerObservation): string {
  const label = observation.category === "correction" ? CORRECTION_LABELS[correctionKind(observation.pattern)] : PROBLEM_LABELS[observation.category];
  return `${label} "${observation.subject}" recurred in ${observation.occurrences} distinct evidence items.`;
}

const ruleOf = (observation: GardenerObservation): string | undefined =>
  observation.category === "rule-violation" || observation.pattern.startsWith("correction:rule:") ? observation.subject : undefined;

export function analyzeGardener(input: { projectRoot: string; coreRoot: string }): GardenerResult {
  const manifestPath = join(input.projectRoot, ".paved/manifest.yaml");
  if (!existsSync(manifestPath)) throw new GardenerInputError("Consumer manifest is missing.");
  const { value: manifest } = readValidated(manifestPath, input.coreRoot);
  const name = (manifest as { project?: { name?: string } }).project?.name;
  if (!name) throw new GardenerInputError("Consumer manifest has no project name.");
  const decisions = reviews(input.projectRoot, input.coreRoot);
  const groups = new Map<string, Incident[]>();
  const skipped: SkippedEvidence[] = [];
  const registry = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]);
  for (const incident of [
    ...evidenceIncidents(input.projectRoot, input.coreRoot, skipped), ...generatorIncidents(input.projectRoot),
    ...correctionIncidents(input.projectRoot, registry, skipped),
  ]) {
    const key = `${name}\u0000${incident.pattern}`;
    groups.set(key, [...(groups.get(key) ?? []), incident]);
  }
  const observations: GardenerObservation[] = [];
  for (const [key, incidents] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const unique = [...new Map(incidents.map((incident) => [`${incident.record}\u0000${incident.item}`, incident])).values()]
      .sort((a, b) => `${a.at}:${a.record}:${a.item}`.localeCompare(`${b.at}:${b.record}:${b.item}`));
    const first = unique[0]!;
    const sources = [...new Map(unique.map((item) => [item.record, { type: "file" as const, location: item.record, sha256: item.sourceHash }])).values()]
      .sort((a, b) => a.location.localeCompare(b.location));
    observations.push({
      apiVersion: "paved/v1", kind: "GardenerObservation", id: id("observation", key), consumer: name,
      category: first.category, subject: first.subject, state: first.state, pattern: first.pattern,
      first_observed: first.at, last_observed: unique.at(-1)!.at, occurrences: unique.length,
      evidence: unique.map(({ record, item, revision }) => ({ record, item, ...(revision === undefined ? {} : { revision }) })),
      provenance: { sources }, confidence: first.state === "enforced" ? "high" : first.state === "unknown" ? "unknown" : "medium",
    });
  }

  const byPattern = new Map(observations.map((observation) => [observation.pattern, observation]));
  let rules: Map<string, Omit<RuleEnforcement, "rule">> | undefined;
  const proposed = new Set<string>();
  const proposals: GardenerProposal[] = [];
  const propose = (key: string, primary: GardenerObservation, related: readonly GardenerObservation[], problem: string, base: Diagnosis, enforcement?: RuleEnforcement): void => {
    const supporting = [primary, ...related];
    const evidence = [...new Map(supporting.flatMap((entry) => entry.evidence).map((item) => [`${item.record}\u0000${item.item}`, item])).values()];
    if (evidence.length < 2) return;
    const sources = [...new Map(supporting.flatMap((entry) => entry.provenance.sources).map((source) => [source.location, source])).values()]
      .sort((a, b) => a.location.localeCompare(b.location));
    const proposalId = id("proposal", key);
    const review = decisions.get(proposalId);
    const evidenceSha = hash(JSON.stringify(sources));
    const currentReview = review?.status === "REJECTED" && review.evidence_sha256 !== evidenceSha ? undefined : review;
    proposals.push({
      apiVersion: "paved/v1", kind: "GardenerProposal", id: proposalId,
      scope: { consumer: name, target: "consumer" }, status: currentReview?.status ?? "CANDIDATE",
      problem, observation: primary.id, evidence, evidence_sha256: evidenceSha, ...base, affected_components: [primary.subject], provenance: { sources },
      ...(related.length === 0 ? {} : { related_observations: related.map((entry) => entry.id) }),
      ...(enforcement === undefined ? {} : { rule_enforcement: enforcement }),
      ...(CHECK_LAYERS.has(base.recommended_layer) ? { adoption_requirement: { condition: "fails-on-recorded-mistake" as const, statement: ADOPTION_STATEMENT, reproduces: evidence } } : {}),
      ...(currentReview === undefined ? {} : { review: { by: currentReview.by, at: currentReview.at, reason: currentReview.reason, ...(currentReview.superseded_by === undefined ? {} : { superseded_by: currentReview.superseded_by }) } }),
    });
  };

  for (const observation of observations) {
    if (observation.category === "implementation-pattern") continue;
    const rule = ruleOf(observation);
    if (rule === undefined) {
      propose(`${name}\u0000${observation.pattern}`, observation, [], problemFor(observation), diagnosis(observation));
      continue;
    }
    if (proposed.has(rule)) continue;
    proposed.add(rule);
    // Violations and human corrections of one rule are one problem; the id stays the violation's, so earlier reviews still apply.
    const violation = byPattern.get(`rule:${rule}`);
    const correction = byPattern.get(`correction:rule:${rule}`);
    const primary = violation ?? correction!;
    const related = violation !== undefined && correction !== undefined ? [correction] : [];
    rules ??= ruleEnforcement(input.projectRoot, input.coreRoot);
    const known = rules.get(rule);
    const promote = known !== undefined && known.mechanism !== "automated";
    const assessment = known !== undefined && promote ? promotionDiagnosis(rule, known) : ruleDiagnosis(rule);
    const count = new Set([...primary.evidence, ...related.flatMap((entry) => entry.evidence)].map((item) => `${item.record}\u0000${item.item}`)).size;
    propose(`${name}\u0000rule:${rule}`, primary, related,
      correction === undefined ? problemFor(primary) : `Rule "${rule}" was violated or corrected by a person in ${count} distinct evidence items.`,
      assessment,
      known === undefined ? undefined : { rule, ...known, promotion_candidate: promote });
  }
  return { consumer: name, observations, proposals, skipped };
}

/** Explicit, read-only comparison for human reviewers; never called by the consumer CLI. */
export function considerCoreCandidates(results: readonly GardenerResult[]): CoreImprovementCandidate[] {
  const names = results.map((result) => result.consumer);
  if (new Set(names).size !== names.length) throw new GardenerInputError("Each compared consumer must have a distinct name.");
  const groups = new Map<string, { consumer: string; observation: GardenerObservation }[]>();
  for (const result of results) {
    const proposed = new Set(result.proposals.map((proposal) => proposal.observation));
    for (const observation of result.observations.filter((entry) => proposed.has(entry.id))) {
      groups.set(observation.pattern, [...(groups.get(observation.pattern) ?? []), { consumer: result.consumer, observation }]);
    }
  }
  return [...groups].filter(([, entries]) => entries.length >= 2).sort(([a], [b]) => a.localeCompare(b)).map(([pattern, entries]) => {
    const sorted = entries.sort((a, b) => a.consumer.localeCompare(b.consumer));
    const consumers = sorted.map((entry) => entry.consumer);
    return {
      apiVersion: "paved/v1" as const, kind: "CoreImprovementCandidate" as const,
      id: id("core-candidate", `${pattern}\u0000${consumers.join("\u0000")}`), status: "CANDIDATE" as const,
      pattern, consumers,
      observations: sorted.map(({ consumer, observation }) => ({ consumer, observation: observation.id, evidence: observation.evidence })),
      generality: "unknown" as const, technology_independence: "unknown" as const, approval_required: true as const,
      problem: `The same recorded problem recurred in ${consumers.length} consumers.`,
      uncertainty: "Shared check identity does not prove technology independence or Core ownership; human review must establish both.",
    };
  });
}
