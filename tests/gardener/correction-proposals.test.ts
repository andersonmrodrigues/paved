import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { similarity } from "../../cli/lib/gardener-corrections.ts";
import { createRegistry } from "../../cli/lib/schemas.ts";
import type { CommandResult } from "../../cli/result.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const CORE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const registry = createRegistry(join(CORE, "schemas"), ["paved/v1"]);
const STATEMENT = "Applied migrations are immutable: never edit one, always add a new migration.";
afterEach(cleanupTemporaryDirectories);

interface CorrectionData { outcome: string; rule_id: string; proposal?: string; proposal_for?: string; occurrences: number; duplicate_of?: { id: string; origin: string }; related: unknown[]; written: boolean }

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function consumer(): string {
  const dir = temporaryDirectory("paved-gardener-correction");
  write(dir, ".paved/manifest.yaml", stringify({ apiVersion: "paved/v1", kind: "Project", project: { name: "corrections" }, paved: { core: "^0.2.0" } }));
  write(dir, "db/migrations/V1__create.sql", "create table a (id int);\n");
  write(dir, "db/migrations/V2__alter.sql", "alter table a add column b int;\n");
  return dir;
}

const cli = (dir: string, ...argv: string[]): Promise<CommandResult> =>
  dispatchCli({ argv: [...argv, "--project", dir, "--json"], cwd: dir, executablePath: join(CORE, "cli/index.ts") });

const correct = (dir: string, text: string, ...evidence: string[]): Promise<CommandResult> =>
  cli(dir, "gardener", "correction", "--text", text, ...evidence.flatMap((ref) => ["--evidence", ref]));

const data = (result: CommandResult) => result.data as CorrectionData;
const projectRules = (dir: string): string[] => existsSync(join(dir, ".paved/rules")) ? readdirSync(join(dir, ".paved/rules"), { recursive: true }).map(String) : [];

describe("gardener correction proposals", () => {
  it("proposes a person's correction verbatim, with evidence, and leaves adoption to that person", async () => {
    const dir = consumer();
    const result = await correct(dir, STATEMENT, "db/migrations/V1__create.sql:1", "https://example.com/incident");
    assert.equal(result.status, "warning", JSON.stringify(result));
    const outcome = data(result);
    assert.equal(outcome.outcome, "proposed");
    assert.match(outcome.rule_id, /^project\.corrections\.applied-migrations-are-immutable[a-z-]*-[a-f0-9]{8}$/);
    assert.match(outcome.proposal ?? "", /^\.paved\/generated\/proposals\/rules\/corrections\/.+\.yaml$/);
    assert.match(outcome.proposal_for ?? "", /^\.paved\/rules\/corrections\/.+\.yaml$/);
    assert.deepEqual(projectRules(dir), [], "human-owned rules are never written by the proposal");

    const content = readFileSync(join(dir, outcome.proposal!), "utf8");
    assert.match(content, /^# Proposed by `paved gardener correction`/);
    const rule = parse(content) as Record<string, unknown>;
    assert.equal(registry.validate(rule).valid, true, registry.validate(rule).errors.join("; "));
    assert.equal(rule.rule, STATEMENT);
    assert.deepEqual(rule.enforcement, { mechanism: "agent", layer: "rule" });
    assert.deepEqual(rule.references, ["db/migrations/V1__create.sql", "https://example.com/incident"]);

    const sidecar = parse(readFileSync(join(dir, `${outcome.proposal}.paved.yaml`), "utf8")) as { ownership: string; artifact: { proposal_for: string }; provenance: { generator: string; sources: { type: string; location: string; lines?: string; sha256?: string }[] } };
    assert.equal(registry.validate(sidecar).valid, true, registry.validate(sidecar).errors.join("; "));
    assert.equal(sidecar.ownership, "disposable");
    assert.equal(sidecar.artifact.proposal_for, outcome.proposal_for);
    assert.equal(sidecar.provenance.generator, "gardener");
    assert.deepEqual(sidecar.provenance.sources.map((source) => source.type), ["human", "file", "url"]);
    assert.equal(sidecar.provenance.sources[1]?.lines, "1");
    assert.match(sidecar.provenance.sources[1]?.sha256 ?? "", /^[a-f0-9]{64}$/);

    assert.equal(result.decisions?.length, 1);
    assert.match(result.decisions?.[0]?.question ?? "", new RegExp(outcome.rule_id.replaceAll(".", "\\.")));
    assert.deepEqual(result.decisions?.[0]?.options.map((option) => option.id), ["adopt", "decline"]);
  });

  it("merges a restatement into the pending proposal instead of duplicating it", async () => {
    const dir = consumer();
    const first = data(await correct(dir, STATEMENT, "db/migrations/V1__create.sql"));
    const again = data(await correct(dir, "applied migrations are IMMUTABLE - never edit one; always add a new migration", "db/migrations/V2__alter.sql"));
    assert.equal(again.outcome, "merged");
    assert.equal(again.proposal, first.proposal);
    assert.equal(again.occurrences, 2);
    assert.equal(readdirSync(join(dir, ".paved/generated/proposals/rules/corrections")).filter((file) => !file.endsWith(".paved.yaml")).length, 1);
    const rule = parse(readFileSync(join(dir, first.proposal!), "utf8")) as { rule: string; rationale: string; references: string[] };
    assert.equal(rule.rule, STATEMENT, "the first wording stays the rule text");
    assert.match(rule.rationale, /2 times/);
    assert.deepEqual(rule.references, ["db/migrations/V1__create.sql", "db/migrations/V2__alter.sql"]);
  });

  it("writes nothing when the correction restates an existing project rule", async () => {
    const dir = consumer();
    write(dir, ".paved/rules/data/migrations.yaml", stringify({
      apiVersion: "paved/v1", kind: "Rule", id: "project.data.immutable-migrations", title: "Applied migrations are immutable",
      rationale: "Deployed databases already ran them.", applies_to: { paths: ["db/migrations/**"] },
      rule: "Never edit an applied migration; always add a new migration.", enforcement: { mechanism: "review" }, severity: "error",
      verification: "The diff edits no existing migration.",
    }));
    const result = await correct(dir, STATEMENT, "db/migrations/V1__create.sql");
    assert.equal(result.status, "warning");
    assert.equal(data(result).outcome, "duplicate");
    assert.equal(data(result).written, false);
    assert.deepEqual(data(result).duplicate_of && { id: data(result).duplicate_of!.id, origin: data(result).duplicate_of!.origin }, { id: "project.data.immutable-migrations", origin: "project" });
    assert.equal(existsSync(join(dir, ".paved/generated/proposals")), false);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PAVED_GARDENER_CORRECTION_DUPLICATE"));
  });

  it("adopts a proposal only on the person's answer, into .paved/rules without the draft header", async () => {
    const dir = consumer();
    const proposed = await correct(dir, STATEMENT, "db/migrations/V1__create.sql");
    const decision = proposed.decisions![0]!.id;
    const adopted = await cli(dir, "gardener", "--answer", `${decision}=adopt`, "--answered-by", "owner");
    assert.notEqual(adopted.status, "failed", JSON.stringify(adopted.diagnostics));
    const target = data(proposed).proposal_for!;
    assert.deepEqual((adopted.data as { applied: string[] }).applied, [target]);
    const content = readFileSync(join(dir, target), "utf8");
    assert.doesNotMatch(content, /^#/m);
    const rule = parse(content) as Record<string, unknown>;
    assert.equal(registry.validate(rule).valid, true);
    assert.equal(rule.id, data(proposed).rule_id);
    assert.equal(existsSync(join(dir, data(proposed).proposal!)), false);
    assert.equal(existsSync(join(dir, `${data(proposed).proposal}.paved.yaml`)), false);

    const restated = await correct(dir, STATEMENT, "db/migrations/V2__alter.sql");
    assert.equal(data(restated).outcome, "duplicate");
    assert.equal(data(restated).duplicate_of?.origin, "project");
  });

  it("records a decline without writing a rule, and asks again when the correction is restated", async () => {
    const dir = consumer();
    const proposed = await correct(dir, STATEMENT, "db/migrations/V1__create.sql");
    const declined = await cli(dir, "gardener", "--answer", `${proposed.decisions![0]!.id}=decline`, "--answered-by", "owner");
    assert.notEqual(declined.status, "failed", JSON.stringify(declined.diagnostics));
    assert.deepEqual(projectRules(dir), []);
    assert.equal((await cli(dir, "gardener")).decisions?.length ?? 0, 0, "a declined correction is not asked again for the same evidence");
    const restated = await correct(dir, STATEMENT, "db/migrations/V2__alter.sql");
    assert.equal(data(restated).outcome, "merged");
    assert.equal(restated.decisions?.length, 1);
  });

  it("accepts a commit as evidence and refuses free text, missing evidence and misplaced flags", async () => {
    const dir = consumer();
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    const commit = git(dir, "rev-parse", "HEAD");
    const withCommit = await correct(dir, STATEMENT, commit.slice(0, 10));
    assert.equal(data(withCommit).outcome, "proposed");
    const sidecar = parse(readFileSync(join(dir, `${data(withCommit).proposal}.paved.yaml`), "utf8")) as { provenance: { source_revision: string; sources: { type: string; location: string }[] } };
    assert.deepEqual(sidecar.provenance.sources[1], { id: "source-2", type: "revision", location: commit, revision: commit });
    assert.equal(sidecar.provenance.source_revision, commit);

    const other = consumer();
    const freeText = await correct(other, STATEMENT, "the agent edited V1 again");
    assert.equal(freeText.status, "failed");
    assert.equal(freeText.diagnostics[0]?.code, "PAVED_GARDENER_INPUT");
    assert.equal(existsSync(join(other, ".paved/generated")), false);
    const noEvidence = await correct(other, STATEMENT);
    assert.match(noEvidence.diagnostics[0]?.message ?? "", /at least one --evidence/);
    const escaping = await correct(other, STATEMENT, "../outside.sql");
    assert.equal(escaping.status, "failed");
    const misplaced = await cli(other, "gardener", "--text", STATEMENT);
    assert.equal(misplaced.status, "failed");
    const elsewhere = await cli(other, "status", "--text", STATEMENT);
    assert.equal(elsewhere.diagnostics[0]?.code, "PAVED_CLI_USAGE");
  });

  it("writes nothing with --dry-run", async () => {
    const dir = consumer();
    const result = await cli(dir, "gardener", "correction", "--dry-run", "--text", STATEMENT, "--evidence", "db/migrations/V1__create.sql");
    assert.equal(data(result).outcome, "proposed");
    assert.equal(data(result).written, false);
    assert.equal(existsSync(join(dir, ".paved/generated")), false);
  });

  it("lists pending correction proposals in the gardener analysis", async () => {
    const dir = consumer();
    await correct(dir, STATEMENT, "db/migrations/V1__create.sql");
    const analysis = await cli(dir, "gardener");
    assert.equal(analysis.status, "warning");
    assert.equal((analysis.data as { corrections: unknown[] }).corrections.length, 1);
    assert.equal(analysis.decisions?.length, 1);
  });
});

describe("correction similarity", () => {
  it("ignores case, punctuation, diacritics and plurals", () => {
    assert.equal(similarity("Não use textos fixos na interface!", "nao use textos fixos na interface"), 1);
    assert.equal(similarity("Labels in three languages", "label in three language"), 1);
    assert.ok(similarity("Never read credentials", "Applied migrations are immutable") < 0.3);
  });
});
