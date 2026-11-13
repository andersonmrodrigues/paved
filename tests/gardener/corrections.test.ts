import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { analyzeGardener } from "../../cli/lib/gardener.ts";
import { createRegistry } from "../../cli/lib/schemas.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const CORE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RULE = "project.architecture.single-http-client";
const registry = createRegistry(join(CORE, "schemas"), ["paved/v1"]);
afterEach(cleanupTemporaryDirectories);

function consumer(): string {
  const dir = temporaryDirectory("paved-gardener-corrections");
  mkdirSync(join(dir, ".paved/generated/runs"), { recursive: true });
  mkdirSync(join(dir, ".paved/generated/evidence"), { recursive: true });
  writeFileSync(join(dir, ".paved/manifest.yaml"), stringify({ apiVersion: "paved/v1", kind: "Project", project: { name: "corrections" }, paved: { core: "^0.2.0" } }));
  return dir;
}

function write(dir: string, path: string, document: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), stringify(document));
}

function rule(dir: string, mechanism: "agent" | "review" | "automated", layer?: string): void {
  write(dir, `.paved/rules/architecture/single-http-client.yaml`, {
    apiVersion: "paved/v1", kind: "Rule", id: RULE, title: "One HTTP client", rationale: "Retries and timeouts live in one place.",
    applies_to: {}, rule: "Use the shared HTTP client.",
    enforcement: { mechanism, ...(layer === undefined ? {} : { layer }), ...(mechanism === "automated" ? { check: "project.lint.http-client" } : {}) },
    severity: "error", verification: "The diff adds no second client.",
  });
}

function violation(dir: string, id: string, date: string): void {
  const record = parse(readFileSync(join(CORE, "tests/fixtures/evidence/synthetic/failed.yaml"), "utf8")) as Record<string, unknown>;
  record.id = id;
  record.created_at = date;
  record.rules = [{ id: RULE, severity: "error", status: "violated", note: "A second client was added." }];
  write(dir, `.paved/generated/evidence/${id}.yaml`, record);
}

const phases = (planning: Record<string, unknown>) => [
  { phase: "context", status: "completed" }, { phase: "discovery", status: "completed" }, planning,
  ...["implementation", "validation", "verification", "evidence", "review", "completion"].map((phase) => ({ phase, status: "pending" })),
];

function rejectedRun(dir: string, id: string, at: string): void {
  const failure = { code: "approval-rejected", phase: "planning", reason: "Human rejected the plan.", retry: "non-retryable", next_action: "Revise the plan." };
  write(dir, `.paved/generated/runs/${id}.yaml`, {
    apiVersion: "paved/v1", kind: "WorkflowRun", id, workflow: { id: "core.feature", version: "0.5.0" }, revision: "abc1234",
    started_at: "2026-01-01T00:00:00Z", ended_at: at, status: "blocked", inputs: [],
    phases: phases({ phase: "planning", status: "blocked", failure,
      gates: [{ id: "plan-approved", status: "rejected", decided_by: "owner", decided_at: at }] }),
    failure, events: [{ at: "2026-01-01T00:00:00Z", type: "run-started" }],
  });
}

function reviewDecision(id: string, answer: string, at: string): Record<string, unknown> {
  const decision = parse(readFileSync(join(CORE, "tests/fixtures/schemas/decision/valid/answered-with-handler.yaml"), "utf8")) as Record<string, unknown>;
  return {
    ...decision, id, run: undefined, command: "execute", handler: "run.review", effect: "record-only", answer, answered_at: at,
    options: [
      { id: "fix", label: "Fix them", description: "Go back to implementation.", consequence: "The fix is reviewed again." },
      { id: "accept", label: "Accept", description: "Complete with the findings.", consequence: "The findings stay on record." },
    ],
    recommended_option: "fix", applied_changes: [],
  };
}

/** A run whose review found blocking findings and a person chose `answer`; `rules` are the rules the findings cited. */
function reviewedRun(dir: string, id: string, at: string, answer: "fix" | "accept", rules: string[] = []): void {
  const digest = (id.at(-1) ?? "0").repeat(64).replace(/[^a-f0-9]/g, "a");
  const outcome = answer === "fix" ? " (fix)" : " (accepted)";
  const decisionId = `d-${(id.at(-1) ?? "0").repeat(20).replace(/[^a-f0-9]/g, "b")}`;
  write(dir, `.paved/generated/runs/${id}.yaml`, {
    apiVersion: "paved/v1", kind: "WorkflowRun", id, workflow: { id: "core.feature", version: "0.5.0" }, revision: "abc1234",
    started_at: "2026-01-01T00:00:00Z", status: "running", inputs: [],
    phases: phases({ phase: "planning", status: "completed", gates: [{ id: "plan-approved", status: "approved", decided_by: "owner", decided_at: "2026-01-01T00:01:00Z" }] })
      .map((phase) => phase.phase === "implementation" ? { ...phase, status: "running" } : phase),
    decisions: [{ ...reviewDecision(decisionId, answer, at), run: id }],
    events: [
      { at: "2026-01-01T00:00:00Z", type: "run-started" },
      { at, type: "evidence-recorded", phase: "review", ref: `.paved/generated/reviews/${id}-findings.yaml`,
        detail: `sha256=${digest}; reviewer=subagent; blocking=1${outcome}; notes=0${rules.length ? `; rules=${rules.join(",")}` : ""}` },
    ],
  });
}

const listing = (dir: string) => JSON.stringify(readdirSync(dir, { recursive: true }).sort());

describe("gardener corrections", () => {
  it("turns recurring plan rejections into a correction observation and a human-review proposal", () => {
    const dir = consumer();
    rejectedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa1", "2026-01-02T00:00:00Z");
    const single = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
    assert.equal(single.observations[0]?.category, "correction");
    assert.equal(single.proposals.length, 0, "one correction is not a pattern");

    rejectedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa2", "2026-01-03T00:00:00Z");
    const before = listing(dir);
    const result = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
    assert.deepEqual(result, analyzeGardener({ projectRoot: dir, coreRoot: CORE }));
    assert.equal(listing(dir), before, "the gardener writes nothing");
    const observation = result.observations.find((entry) => entry.pattern === "correction:plan-rejected:core.feature");
    assert.ok(observation);
    assert.equal(observation.state, "documented");
    assert.equal(observation.occurrences, 2);
    assert.ok(observation.provenance.sources.every((source) => source.location.startsWith(".paved/generated/runs/") && /^[a-f0-9]{64}$/.test(source.sha256)));
    const proposal = result.proposals[0]!;
    assert.equal(proposal.recommended_layer, "human-review");
    assert.equal(proposal.adoption_requirement, undefined);
    assert.match(proposal.problem, /Plan rejected by a person in workflow "core.feature" recurred in 2/);
    for (const document of [observation, proposal]) assert.equal(registry.validate(document).valid, true, JSON.stringify(registry.validate(document).errors));
  });

  it("counts review findings a person sent back, not findings accepted as they are", () => {
    const dir = consumer();
    reviewedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa1", "2026-01-02T00:00:00Z", "fix");
    reviewedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa2", "2026-01-03T00:00:00Z", "accept");
    assert.equal(analyzeGardener({ projectRoot: dir, coreRoot: CORE }).proposals.length, 0);
    reviewedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa3", "2026-01-04T00:00:00Z", "fix");
    const result = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
    const observation = result.observations.find((entry) => entry.pattern === "correction:review-fix:core.feature");
    assert.equal(observation?.occurrences, 2);
    assert.ok(observation.evidence.every((item) => !item.record.endsWith("aaa2.yaml")));
    assert.equal(result.proposals.length, 1);
  });

  it("promotes a rule enforced only by the agent once violations and corrections recur", () => {
    const dir = consumer();
    rule(dir, "agent", "rule");
    violation(dir, "violation-one", "2026-01-01T00:00:00Z");
    const alone = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
    assert.equal(alone.proposals.filter((entry) => entry.affected_components.includes(RULE)).length, 0);

    reviewedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa1", "2026-01-02T00:00:00Z", "fix", [RULE, "not a rule"]);
    const result = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
    const proposals = result.proposals.filter((entry) => entry.affected_components.includes(RULE));
    assert.equal(proposals.length, 1, "a violation and a correction of one rule are one proposal");
    const proposal = proposals[0]!;
    assert.equal(proposal.evidence.length, 2);
    assert.equal(proposal.related_observations?.length, 1);
    assert.deepEqual(proposal.rule_enforcement, { rule: RULE, mechanism: "agent", layer: "rule", promotion_candidate: true });
    assert.equal(proposal.recommended_layer, "static-analysis");
    assert.match(proposal.layer_rationale, /architecture, static analysis .*test or CI check, and only then documentation/);
    assert.equal(proposal.adoption_requirement?.condition, "fails-on-recorded-mistake");
    assert.match(proposal.adoption_requirement?.statement ?? "", /failing on a fixture that reproduces one of the recorded mistakes/);
    assert.deepEqual(proposal.adoption_requirement?.reproduces, proposal.evidence);
    assert.match(proposal.problem, /violated or corrected by a person in 2 distinct evidence items/);
    assert.equal(registry.validate(proposal).valid, true, JSON.stringify(registry.validate(proposal).errors));
    assert.ok(!result.observations.some((entry) => entry.subject === "not a rule"));

    // Two violations alone produce the same proposal id, so a review recorded earlier still applies.
    const violationsOnly = consumer();
    rule(violationsOnly, "agent", "rule");
    violation(violationsOnly, "violation-one", "2026-01-01T00:00:00Z");
    violation(violationsOnly, "violation-two", "2026-01-02T00:00:00Z");
    const earlier = analyzeGardener({ projectRoot: violationsOnly, coreRoot: CORE }).proposals.find((entry) => entry.affected_components.includes(RULE));
    assert.equal(earlier?.id, proposal.id);
    assert.equal(earlier?.related_observations, undefined);
  });

  it("recommends a stronger layer than the rule already has, and no promotion for an automated rule", () => {
    const layered = consumer();
    rule(layered, "review", "static-analysis");
    reviewedRun(layered, "intent-aaaaaaaaaaaaaaaaaaa1", "2026-01-02T00:00:00Z", "fix", [RULE]);
    reviewedRun(layered, "intent-aaaaaaaaaaaaaaaaaaa2", "2026-01-03T00:00:00Z", "fix", [RULE]);
    const promoted = analyzeGardener({ projectRoot: layered, coreRoot: CORE }).proposals.find((entry) => entry.affected_components.includes(RULE));
    assert.equal(promoted?.recommended_layer, "architecture");
    assert.equal(promoted?.observation, analyzeGardener({ projectRoot: layered, coreRoot: CORE }).observations.find((entry) => entry.pattern === `correction:rule:${RULE}`)?.id);

    const automated = consumer();
    rule(automated, "automated");
    violation(automated, "violation-one", "2026-01-01T00:00:00Z");
    violation(automated, "violation-two", "2026-01-02T00:00:00Z");
    const proposal = analyzeGardener({ projectRoot: automated, coreRoot: CORE }).proposals.find((entry) => entry.affected_components.includes(RULE));
    assert.equal(proposal?.rule_enforcement?.promotion_candidate, false);
    assert.equal(proposal?.recommended_layer, "static-analysis");
  });

  it("skips an invalid run record, names it, and keeps analyzing", async () => {
    const dir = consumer();
    rejectedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa1", "2026-01-02T00:00:00Z");
    rejectedRun(dir, "intent-aaaaaaaaaaaaaaaaaaa2", "2026-01-03T00:00:00Z");
    writeFileSync(join(dir, ".paved/generated/runs/intent-aaaaaaaaaaaaaaaaaaa3.yaml"), stringify({ apiVersion: "paved/v1", kind: "WorkflowRun", id: "broken" }));
    const result = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
    assert.deepEqual(result.skipped.map((entry) => entry.record), [".paved/generated/runs/intent-aaaaaaaaaaaaaaaaaaa3.yaml"]);
    assert.equal(result.proposals.length, 1);
    const cli = await dispatchCli({ argv: ["gardener", "--project", dir, "--json"], cwd: dir, executablePath: join(CORE, "cli/index.ts") });
    const skipped = cli.diagnostics.find((diagnostic) => diagnostic.code === "PAVED_GARDENER_EVIDENCE_SKIPPED");
    assert.match(skipped?.message ?? "", /aaa3\.yaml: it is not a valid workflow run/);
  });
});
