import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { analyzeGardener, considerCoreCandidates } from "../../cli/lib/gardener.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { exitCode } from "../../cli/result.ts";
import { createRegistry } from "../../cli/lib/schemas.ts";

const CORE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function consumer(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "paved-gardener-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".paved/generated/evidence"), { recursive: true });
  writeFileSync(join(dir, ".paved/manifest.yaml"), stringify({ apiVersion: "paved/v1", kind: "Project", project: { name }, paved: { core: "^0.2.0" } }));
  return dir;
}

function evidence(dir: string, id: string, date: string): void {
  const source = join(CORE, "tests/fixtures/evidence/synthetic/failed.yaml");
  const record = parse(readFileSync(source, "utf8")) as Record<string, unknown>;
  record.id = id;
  record.created_at = date;
  writeFileSync(join(dir, `.paved/generated/evidence/${id}.yaml`), stringify(record));
}

it("groups distinct verification runs deterministically, preserves provenance and never writes consumer files", () => {
  const dir = consumer("fixture-a");
  evidence(dir, "run-one", "2026-01-01T00:00:00Z");
  const once = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
  assert.ok(once.observations.length > 0);
  assert.equal(once.proposals.length, 0);
  evidence(dir, "run-two", "2026-01-02T00:00:00Z");
  const before = readFileSync(join(dir, ".paved/generated/evidence/run-one.yaml"), "utf8");
  const first = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
  const second = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
  assert.deepEqual(first, second);
  const proposal = first.proposals.find((entry) => entry.problem.includes("project.synthetic.integration"));
  assert.ok(proposal);
  assert.equal(proposal.status, "CANDIDATE");
  assert.equal(proposal.scope.consumer, "fixture-a");
  assert.equal(proposal.root_cause_state, "unknown");
  assert.equal(proposal.evidence.length, 2);
  assert.ok(proposal.provenance.sources.every((source) => source.location.startsWith(".paved/")));
  assert.equal(createRegistry(join(CORE, "schemas"), ["paved/v1"]).validate(proposal).valid, true);
  assert.equal(readFileSync(join(dir, ".paved/generated/evidence/run-one.yaml"), "utf8"), before);
  assert.equal(existsSync(join(dir, ".paved/gardener")), false);
});

it("keeps consumer patterns separate and reads human rejection without suppressing evidence", () => {
  const a = consumer("consumer-a");
  const b = consumer("consumer-b");
  for (const dir of [a, b]) { evidence(dir, "run-one", "2026-01-01T00:00:00Z"); evidence(dir, "run-two", "2026-01-02T00:00:00Z"); }
  const before = analyzeGardener({ projectRoot: a, coreRoot: CORE });
  const proposal = before.proposals[0]!;
  assert.notEqual(proposal.id, analyzeGardener({ projectRoot: b, coreRoot: CORE }).proposals[0]!.id);
  mkdirSync(join(a, ".paved/gardener"));
  writeFileSync(join(a, ".paved/gardener/reviews.yaml"), stringify({ apiVersion: "paved/v1", kind: "GardenerReviews", reviews: [
    { proposal: proposal.id, status: "REJECTED", by: "maintainer", at: "2026-01-03T00:00:00Z", reason: "Context specific.", evidence_sha256: proposal.evidence_sha256 },
  ] }));
  const rejected = analyzeGardener({ projectRoot: a, coreRoot: CORE });
  assert.equal(rejected.proposals[0]?.status, "REJECTED");
  assert.equal(rejected.observations[0]?.occurrences, 2);
  assert.equal(analyzeGardener({ projectRoot: b, coreRoot: CORE }).proposals[0]?.status, "CANDIDATE");
  evidence(a, "run-three", "2026-01-04T00:00:00Z");
  assert.equal(analyzeGardener({ projectRoot: a, coreRoot: CORE }).proposals[0]?.status, "CANDIDATE");
});

it("rejects implementation without prior acceptance", () => {
  const dir = consumer("review-gate");
  evidence(dir, "run-one", "2026-01-01T00:00:00Z");
  evidence(dir, "run-two", "2026-01-02T00:00:00Z");
  const id = analyzeGardener({ projectRoot: dir, coreRoot: CORE }).proposals[0]!.id;
  mkdirSync(join(dir, ".paved/gardener"));
  writeFileSync(join(dir, ".paved/gardener/reviews.yaml"), stringify({ apiVersion: "paved/v1", kind: "GardenerReviews", reviews: [
    { proposal: id, status: "IMPLEMENTED", by: "maintainer", at: "2026-01-03T00:00:00Z", reason: "Claimed.", evidence_sha256: "a".repeat(64) },
  ] }));
  assert.throws(() => analyzeGardener({ projectRoot: dir, coreRoot: CORE }), /Invalid Gardener review transition/);
});

it("records acceptance, implementation, and supersession only through review events", () => {
  const dir = consumer("review-sequence");
  evidence(dir, "run-one", "2026-01-01T00:00:00Z");
  evidence(dir, "run-two", "2026-01-02T00:00:00Z");
  const candidate = analyzeGardener({ projectRoot: dir, coreRoot: CORE }).proposals[0]!;
  mkdirSync(join(dir, ".paved/gardener"));
  const reviewPath = join(dir, ".paved/gardener/reviews.yaml");
  const entry = (status: string) => ({ proposal: candidate.id, status, by: "maintainer", at: "2026-01-03T00:00:00Z", reason: "Reviewed evidence.", evidence_sha256: candidate.evidence_sha256 });
  writeFileSync(reviewPath, stringify({ apiVersion: "paved/v1", kind: "GardenerReviews", reviews: [entry("ACCEPTED"), entry("IMPLEMENTED")] }));
  assert.equal(analyzeGardener({ projectRoot: dir, coreRoot: CORE }).proposals[0]?.status, "IMPLEMENTED");
  writeFileSync(reviewPath, stringify({ apiVersion: "paved/v1", kind: "GardenerReviews", reviews: [{ ...entry("UNDER_REVIEW") }, { ...entry("SUPERSEDED"), superseded_by: "proposal-aaaaaaaaaaaaaaaaaaaa" }] }));
  const superseded = analyzeGardener({ projectRoot: dir, coreRoot: CORE }).proposals[0];
  assert.equal(superseded?.status, "SUPERSEDED");
  assert.equal(superseded.review?.superseded_by, "proposal-aaaaaaaaaaaaaaaaaaaa");
});

it("CLI returns findings and JSON-ready structured data", async () => {
  const dir = consumer("cli-consumer");
  evidence(dir, "run-one", "2026-01-01T00:00:00Z");
  evidence(dir, "run-two", "2026-01-02T00:00:00Z");
  const result = await dispatchCli({ argv: ["gardener", "--project", dir, "--json"], cwd: dir, executablePath: join(CORE, "cli/index.ts") });
  assert.equal(exitCode(result), 1);
  assert.ok((result.data as { proposals: unknown[] }).proposals.length > 0);
  const dryRun = await dispatchCli({ argv: ["gardener", "--project", dir, "--dry-run", "--json"], cwd: dir, executablePath: join(CORE, "cli/index.ts") });
  assert.equal(exitCode(dryRun), 1);
  assert.deepEqual((dryRun.data as { proposals: unknown[] }).proposals, (result.data as { proposals: unknown[] }).proposals);
});

it("CLI reports broken input without changing consumer state", async () => {
  const dir = consumer("invalid-input");
  const path = join(dir, ".paved/generated/state/last-run.json");
  mkdirSync(join(dir, ".paved/generated/state"));
  writeFileSync(path, "{invalid");
  const before = readFileSync(path, "utf8");
  const result = await dispatchCli({ argv: ["gardener", "--project", dir, "--json"], cwd: dir, executablePath: join(CORE, "cli/index.ts") });
  assert.equal(exitCode(result), 4);
  assert.equal(readFileSync(path, "utf8"), before);
});

it("proposes a workflow review for recurring missing required verification", () => {
  const dir = consumer("fixture-process");
  const source = join(CORE, "tests/fixtures/evidence/synthetic/blocked.yaml");
  for (const [id, date] of [["process-one", "2026-01-01T00:00:00Z"], ["process-two", "2026-01-02T00:00:00Z"]]) {
    const record = parse(readFileSync(source, "utf8")) as { id: string; created_at: string; plan: { required: string[] } };
    record.id = id!;
    record.created_at = date!;
    record.plan.required.push("security");
    writeFileSync(join(dir, `.paved/generated/evidence/${id}.yaml`), stringify(record));
  }
  const result = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
  const proposal = result.proposals.find((entry) => entry.recommended_layer === "workflow");
  assert.ok(proposal);
  assert.equal(proposal.root_cause_state, "unknown");
});

it("does not learn a repeated source-code pattern without authoritative evidence", () => {
  const dir = consumer("fixture-existing-pattern");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/controller-a.txt"), "controller calls database directly");
  writeFileSync(join(dir, "src/controller-b.txt"), "controller calls database directly");
  const result = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.proposals, []);
  const source = join(CORE, "tests/fixtures/evidence/synthetic/success.yaml");
  for (const id of ["pattern-one", "pattern-two"]) {
    const record = parse(readFileSync(source, "utf8")) as { id: string; checks: { observations?: { name: string; value: string }[] }[] };
    record.id = id;
    record.checks[0]!.observations = [{ name: "implementation-pattern", value: "controller-to-database" }];
    writeFileSync(join(dir, `.paved/generated/evidence/${id}.yaml`), stringify(record));
  }
  const observed = analyzeGardener({ projectRoot: dir, coreRoot: CORE });
  assert.equal(observed.observations.find((entry) => entry.category === "implementation-pattern")?.occurrences, 2);
  assert.equal(observed.proposals.length, 0);
});

it("creates only a review-only Core candidate when two consumers are explicitly compared", () => {
  const a = consumer("alpha");
  const b = consumer("beta");
  for (const dir of [a, b]) { evidence(dir, "run-one", "2026-01-01T00:00:00Z"); evidence(dir, "run-two", "2026-01-02T00:00:00Z"); }
  const results = [analyzeGardener({ projectRoot: a, coreRoot: CORE }), analyzeGardener({ projectRoot: b, coreRoot: CORE })];
  const first = considerCoreCandidates(results);
  assert.deepEqual(first, considerCoreCandidates(results));
  assert.ok(first.length > 0);
  assert.deepEqual(first[0]?.consumers, ["alpha", "beta"]);
  assert.equal(first[0]?.status, "CANDIDATE");
  assert.equal(first[0]?.generality, "unknown");
  assert.equal(first[0]?.approval_required, true);
  assert.equal(createRegistry(join(CORE, "schemas"), ["paved/v1"]).validate(first[0]).valid, true);
  assert.equal(considerCoreCandidates([results[0]!]).length, 0);
});
