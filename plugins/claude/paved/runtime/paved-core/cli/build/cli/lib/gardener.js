import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { assessEvidence, loadEvidenceRegistry } from "./evidence.js";
import { createRegistry } from "./schemas.js";
export class GardenerInputError extends Error {
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (prefix, value) => `${prefix}-${hash(value).slice(0, 20)}`;
const posix = (value) => value.split(sep).join("/");
function files(dir, suffix) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => join(dir, entry.name)).sort();
}
function readValidated(path, coreRoot) {
    const raw = readFileSync(path, "utf8");
    let value;
    try {
        value = parse(raw);
    }
    catch {
        throw new GardenerInputError("Invalid Gardener input YAML.");
    }
    const result = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(value);
    if (!result.valid)
        throw new GardenerInputError(`Invalid Gardener input: ${result.errors.join("; ")}`);
    return { raw, value };
}
function reviews(projectRoot, coreRoot) {
    const path = join(projectRoot, ".paved/gardener/reviews.yaml");
    if (!existsSync(path))
        return new Map();
    const { value } = readValidated(path, coreRoot);
    const doc = value;
    const latest = new Map();
    for (const record of doc.reviews) {
        const previous = latest.get(record.proposal)?.status ?? "CANDIDATE";
        const allowed = {
            CANDIDATE: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "DEFERRED"],
            UNDER_REVIEW: ["ACCEPTED", "REJECTED", "DEFERRED", "SUPERSEDED"],
            ACCEPTED: ["IMPLEMENTED", "DEFERRED", "SUPERSEDED"],
            DEFERRED: ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "SUPERSEDED"],
            REJECTED: ["UNDER_REVIEW", "SUPERSEDED"],
            IMPLEMENTED: [], SUPERSEDED: [],
        };
        if (!allowed[previous]?.includes(record.status))
            throw new GardenerInputError(`Invalid Gardener review transition ${previous} -> ${record.status}.`);
        latest.set(record.proposal, record);
    }
    return latest;
}
function evidenceIncidents(projectRoot, coreRoot) {
    const found = [];
    const paths = [
        ...files(join(projectRoot, ".paved/generated/evidence"), ".yaml"),
        ...files(join(projectRoot, ".paved/verification/evidence"), ".yaml"),
    ];
    const seen = new Map();
    for (const path of paths) {
        const { raw, value } = readValidated(path, coreRoot);
        const record = value;
        const problems = assessEvidence(record, loadEvidenceRegistry(join(coreRoot, "core/verification/registry.yaml")));
        if (problems.length > 0)
            throw new GardenerInputError("Evidence record contradicts its recorded observations.");
        // A retained copy and its disposable original represent one run.
        const recordHash = hash(JSON.stringify(record));
        const previous = seen.get(record.id);
        if (previous !== undefined) {
            if (previous !== recordHash)
                throw new GardenerInputError("Evidence id has conflicting record contents.");
            continue;
        }
        seen.set(record.id, recordHash);
        const rel = posix(relative(projectRoot, path));
        const base = { at: record.created_at, record: rel, revision: record.change.revision, sourceHash: hash(raw) };
        for (const check of record.checks) {
            for (const fact of check.observations ?? []) {
                if (fact.name !== "implementation-pattern" || typeof fact.value !== "string")
                    continue;
                const fingerprint = hash(fact.value);
                found.push({ ...base, category: "implementation-pattern", subject: check.check,
                    pattern: `implementation:${check.check}:${fingerprint}`, state: "observed", item: `${check.id}:${fingerprint.slice(0, 20)}` });
            }
            if (check.status !== "failed" && check.status !== "error")
                continue;
            found.push({ ...base, category: "verification-failure", subject: check.check, pattern: `check:${check.check}:${check.status}`, state: "enforced", item: check.id });
        }
        for (const rule of record.rules ?? []) {
            if (rule.status !== "violated")
                continue;
            found.push({ ...base, category: "rule-violation", subject: rule.id, pattern: `rule:${rule.id}`, state: "documented", item: rule.id });
        }
        for (const type of record.plan.required) {
            if (record.checks.some((check) => check.type === type && check.status === "passed"))
                continue;
            if (record.checks.some((check) => check.type === type && (check.status === "failed" || check.status === "error")))
                continue;
            found.push({ ...base, category: "missing-verification", subject: type, pattern: `missing:${type}`, state: "documented", item: type });
        }
    }
    return found;
}
function generatorIncidents(projectRoot) {
    const path = join(projectRoot, ".paved/generated/state/last-run.json");
    if (!existsSync(path))
        return [];
    const raw = readFileSync(path, "utf8");
    let run;
    try {
        run = JSON.parse(raw);
    }
    catch {
        throw new GardenerInputError("Invalid generator last-run state.");
    }
    const rel = posix(relative(projectRoot, path));
    return (run.executions ?? []).flatMap((entry) => {
        if (typeof entry.generator !== "string")
            return [];
        const base = { subject: entry.generator, at: run.timestamp ?? "unknown", record: rel, sourceHash: hash(raw) };
        return [
            ...(entry.status === "conflict" ? [{ ...base, category: "generator-conflict", pattern: `generator:${entry.generator}`, state: "observed", item: entry.generator }] : []),
            ...(entry.unknowns ?? []).map((unknown) => ({ ...base, category: "generator-unknown",
                pattern: `generator-unknown:${entry.generator}:${hash(unknown)}`, state: "unknown", item: hash(unknown).slice(0, 20) })),
        ];
    });
}
function diagnosis(observation) {
    if (observation.category === "missing-verification")
        return {
            root_cause: "The required check was not recorded as passed; the reason for omission is unknown.", root_cause_state: "unknown",
            recommended_layer: "workflow", layer_rationale: "A recurring omitted step is best addressed at the task completion gate; review whether verification already blocks completion.",
            proposed_change: `Review the workflow gate for required ${observation.subject} verification and close any bypass.`, expected_impact: "Tasks cannot be marked complete without the required evidence.",
            uncertainty: "The evidence does not establish why the step was missed or whether a workflow change is necessary.",
        };
    if (observation.category === "generator-conflict")
        return {
            root_cause: "Generated output and its regeneration baseline conflict; the reason for the edits is unknown.", root_cause_state: "inferred",
            recommended_layer: "tool", layer_rationale: "The generator ownership and merge contract is the strongest existing prevention point.",
            proposed_change: `Review ${observation.subject} ownership metadata and safe regeneration behavior.`, expected_impact: "Fewer regeneration conflicts without overwriting human edits.",
            uncertainty: "Human intent behind conflicting edits has not been established.",
        };
    if (observation.category === "generator-unknown")
        return {
            root_cause: "A generator repeatedly could not establish a project fact; the missing authority is unknown.", root_cause_state: "unknown",
            recommended_layer: "human-review", layer_rationale: "Unknown project intent requires a human source before any engineering mechanism can be chosen.",
            proposed_change: `Review the unknown reported by ${observation.subject} and document the intended project fact if appropriate.`,
            expected_impact: "Project context can cite an authoritative source.", uncertainty: "The Gardener cannot infer the desired state from repository repetition.",
        };
    if (observation.category === "rule-violation")
        return {
            root_cause: "The rule is documented but violations recur; the underlying design cause is unknown.", root_cause_state: "unknown",
            recommended_layer: "static-analysis", layer_rationale: "A deterministic recurring rule violation may be preventable by an automated check; review structural detectability first.",
            proposed_change: `Assess whether ${observation.subject} can be checked structurally; otherwise improve the existing rule.`, expected_impact: "Earlier detection of the same violation.",
            uncertainty: "The record does not prove that static analysis can detect this rule.",
        };
    return {
        root_cause: "The configured check repeatedly fails; the underlying engineering cause is unknown.", root_cause_state: "unknown",
        recommended_layer: "architecture", layer_rationale: "Review whether design can prevent the failure before adding another instruction or check.",
        proposed_change: `Investigate ${observation.subject} failures and consider a structural fix before weaker guidance.`, expected_impact: "Prevent recurrence if the root cause is structural.",
        uncertainty: "Check failure alone does not establish architectural intent or a particular fix.",
    };
}
export function analyzeGardener(input) {
    const manifestPath = join(input.projectRoot, ".paved/manifest.yaml");
    if (!existsSync(manifestPath))
        throw new GardenerInputError("Consumer manifest is missing.");
    const { value: manifest } = readValidated(manifestPath, input.coreRoot);
    const name = manifest.project?.name;
    if (!name)
        throw new GardenerInputError("Consumer manifest has no project name.");
    const decisions = reviews(input.projectRoot, input.coreRoot);
    const groups = new Map();
    for (const incident of [...evidenceIncidents(input.projectRoot, input.coreRoot), ...generatorIncidents(input.projectRoot)]) {
        const key = `${name}\u0000${incident.pattern}`;
        groups.set(key, [...(groups.get(key) ?? []), incident]);
    }
    const observations = [];
    const proposals = [];
    for (const [key, incidents] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        const unique = [...new Map(incidents.map((incident) => [`${incident.record}\u0000${incident.item}`, incident])).values()]
            .sort((a, b) => `${a.at}:${a.record}:${a.item}`.localeCompare(`${b.at}:${b.record}:${b.item}`));
        const first = unique[0];
        const sources = [...new Map(unique.map((item) => [item.record, { type: "file", location: item.record, sha256: item.sourceHash }])).values()]
            .sort((a, b) => a.location.localeCompare(b.location));
        const observation = {
            apiVersion: "paved/v1", kind: "GardenerObservation", id: id("observation", key), consumer: name,
            category: first.category, subject: first.subject, state: first.state, pattern: first.pattern,
            first_observed: first.at, last_observed: unique.at(-1).at, occurrences: unique.length,
            evidence: unique.map(({ record, item, revision }) => ({ record, item, ...(revision === undefined ? {} : { revision }) })),
            provenance: { sources }, confidence: first.state === "enforced" ? "high" : first.state === "unknown" ? "unknown" : "medium",
        };
        observations.push(observation);
        if (unique.length < 2 || first.category === "implementation-pattern")
            continue;
        const proposalId = id("proposal", key);
        const review = decisions.get(proposalId);
        const evidenceSha = hash(JSON.stringify(observation.provenance.sources));
        const currentReview = review?.status === "REJECTED" && review.evidence_sha256 !== evidenceSha ? undefined : review;
        const base = diagnosis(observation);
        proposals.push({
            apiVersion: "paved/v1", kind: "GardenerProposal", id: proposalId,
            scope: { consumer: name, target: "consumer" }, status: currentReview?.status ?? "CANDIDATE",
            problem: `${first.subject} recurred in ${unique.length} distinct evidence items.`, observation: observation.id,
            evidence: observation.evidence, evidence_sha256: evidenceSha, ...base, affected_components: [first.subject], provenance: observation.provenance,
            ...(currentReview === undefined ? {} : { review: { by: currentReview.by, at: currentReview.at, reason: currentReview.reason, ...(currentReview.superseded_by === undefined ? {} : { superseded_by: currentReview.superseded_by }) } }),
        });
    }
    return { consumer: name, observations, proposals };
}
/** Explicit, read-only comparison for human reviewers; never called by the consumer CLI. */
export function considerCoreCandidates(results) {
    const names = results.map((result) => result.consumer);
    if (new Set(names).size !== names.length)
        throw new GardenerInputError("Each compared consumer must have a distinct name.");
    const groups = new Map();
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
            apiVersion: "paved/v1", kind: "CoreImprovementCandidate",
            id: id("core-candidate", `${pattern}\u0000${consumers.join("\u0000")}`), status: "CANDIDATE",
            pattern, consumers,
            observations: sorted.map(({ consumer, observation }) => ({ consumer, observation: observation.id, evidence: observation.evidence })),
            generality: "unknown", technology_independence: "unknown", approval_required: true,
            problem: `The same recorded problem recurred in ${consumers.length} consumers.`,
            uncertainty: "Shared check identity does not prove technology independence or Core ownership; human review must establish both.",
        };
    });
}
