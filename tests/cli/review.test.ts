import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { exitCode, type CommandResult } from "../../cli/result.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import type { PreparedReview } from "../../cli/lib/standalone-review.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const CORE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** main with one file, and a feature branch with one commit and one uncommitted change on top. */
function repository(): string {
  const dir = temporaryDirectory("paved-review");
  git(dir, "init", "-q");
  write(dir, ".paved/manifest.yaml", stringify({ apiVersion: "paved/v1", kind: "Project", project: { name: "review" }, paved: { core: "^2.0.0" } }));
  write(dir, ".paved/rules/style/source.yaml", stringify({
    apiVersion: "paved/v1", kind: "Rule", id: "project.style.source", title: "Source style", rationale: "Readable source.",
    applies_to: { paths: ["src/**"] }, rule: "Source files follow the project style.", enforcement: { mechanism: "agent" },
    severity: "warning", verification: "The diff follows the style.",
  }));
  write(dir, ".paved/rules/style/docs.yaml", stringify({
    apiVersion: "paved/v1", kind: "Rule", id: "project.style.docs", title: "Docs style", rationale: "Readable docs.",
    applies_to: { paths: ["docs/**"] }, rule: "Docs follow the project style.", enforcement: { mechanism: "agent" },
    severity: "warning", verification: "The diff follows the style.",
  }));
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "src/a.ts", "export const a = 2;\n");
  git(dir, "commit", "-q", "-am", "change a");
  write(dir, "src/b.ts", "export const b = 1;\n");
  return dir;
}

const cli = (dir: string, ...argv: string[]): Promise<CommandResult> =>
  dispatchCli({ argv: [...argv, "--json"], cwd: dir, executablePath: join(CORE, "cli/index.ts") });
const prepared = (result: CommandResult) => (result.data as { review: PreparedReview }).review;

function record(dir: string, review: PreparedReview, overrides: Record<string, unknown> = {}): string {
  write(dir, review.record, stringify({
    apiVersion: "paved/v1", kind: "ChangeReview", target: review.target,
    reviewer: { agent: "test reviewer", isolated: true }, reviewed: { diff_sha256: review.diff_sha256 },
    passes: ["rules", "diff", "change"], findings: [], ...overrides,
  }));
  return review.record;
}

describe("paved review without a workflow run", () => {
  it("plans a scaled review for branch and untracked sensitive changes without writing artifacts", async () => {
    const dir = repository();
    write(dir, "src/auth/login.ts", "export const login = true;\n");

    const result = await cli(dir, "review", "plan", "--base", "main");

    assert.equal(result.status, "success", JSON.stringify(result));
    const plan = (result.data as { plan: { reviewers: unknown[]; evidence: { sensitiveMatches: { path: string }[] } } }).plan;
    assert.equal(plan.reviewers.length, 3);
    assert.ok(plan.evidence.sensitiveMatches.some((match) => match.path === "src/auth/login.ts"));
    assert.equal(existsSync(join(dir, ".paved/generated/reviews")), false);
  });

  it("counts staged and untracked lines and treats binary files conservatively", async () => {
    const dir = repository();
    write(dir, "src/medium.ts", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n");
    git(dir, "add", "src/medium.ts");

    const medium = await cli(dir, "review", "plan");
    assert.equal(medium.status, "success", JSON.stringify(medium));
    const plan = (medium.data as { plan: { reviewers: unknown[]; evidence: { changedLines: number } } }).plan;
    assert.equal(plan.reviewers.length, 1);
    assert.equal(plan.evidence.changedLines, 61);

    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets/image.bin"), Buffer.from([0, 1, 2]));
    const binary = await cli(dir, "review", "plan");
    const binaryPlan = (binary.data as { plan: { reviewers: unknown[]; evidence: { unknownCountPaths: string[] } } }).plan;
    assert.equal(binaryPlan.reviewers.length, 3);
    assert.deepEqual(binaryPlan.evidence.unknownCountPaths, ["assets/image.bin"]);
  });

  it("uses configured sensitive path patterns and rejects an invalid policy", async () => {
    const dir = repository();
    write(dir, ".paved/review.yaml", stringify({
      apiVersion: "paved/v1", kind: "ReviewPolicy", sensitive_paths: ["src/b.ts"],
    }));

    const result = await cli(dir, "review", "plan");
    const plan = (result.data as { plan: { reviewers: unknown[] } }).plan;
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(plan.reviewers.length, 3);

    write(dir, ".paved/review.yaml", stringify({
      apiVersion: "paved/v1", kind: "ReviewPolicy", sensitive_paths: "src/b.ts",
    }));
    const invalid = await cli(dir, "review", "plan");
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.diagnostics[0]?.code, "PAVED_REVIEW_POLICY_INVALID");
  });

  it("uses project-relative paths when the project is inside a Git repository", async () => {
    const dir = repository();
    write(dir, "nested/.paved/manifest.yaml", stringify({ apiVersion: "paved/v1", kind: "Project" }));
    write(dir, "nested/src/widget.ts", "old\n");
    git(dir, "add", "nested");
    git(dir, "commit", "-q", "-m", "nested project");
    write(dir, "nested/src/widget.ts", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n");

    const result = await cli(join(dir, "nested"), "review", "plan");

    assert.equal(result.status, "success", JSON.stringify(result));
    const files = (result.data as { files: { path: string }[] }).files;
    assert.deepEqual(files.map((file) => file.path), ["src/widget.ts"]);
  });

  it("prepares a brief over everything changed since the base, including uncommitted and untracked files", async () => {
    const dir = repository();
    const result = await cli(dir, "review", "--base", "main");
    assert.equal(result.status, "success", JSON.stringify(result.diagnostics));
    const review = prepared(result);
    assert.equal(review.target.kind, "base");
    assert.equal(review.target.base, git(dir, "rev-parse", "main"));
    assert.equal(review.target.head, git(dir, "rev-parse", "HEAD"));
    assert.equal(review.target.working_tree, true);
    assert.deepEqual(review.files, ["src/a.ts", "src/b.ts"]);
    const diff = readFileSync(join(dir, review.diff));
    assert.equal(createHash("sha256").update(diff).digest("hex"), review.diff_sha256);
    assert.doesNotMatch(diff.toString(), /\.paved\//);
    assert.deepEqual(review.rules.filter((rule) => rule.id.startsWith("project.")).map((rule) => rule.id), ["project.style.source"]);
    const brief = readFileSync(join(dir, review.brief), "utf8");
    assert.match(brief, /kind: ChangeReviewBundle\ntarget:\n {2}kind: base/);
    assert.match(brief, /lens: Skeptic/);
    assert.match(brief, new RegExp(`diff_sha256: ${review.diff_sha256}`));
    assert.match(brief, /`project\.style\.source`/);
    assert.match(brief, new RegExp(`git log --format=%B ${review.target.base}\\.\\.${review.target.head}`), "commits stay listed when uncommitted files ride along");
    assert.equal(existsSync(join(dir, ".paved/generated/runs")), false, "no workflow run is created");
  });

  it("reviews only the commits of a range", async () => {
    const dir = repository();
    const review = prepared(await cli(dir, "review", "--range", "main..feature"));
    assert.equal(review.target.kind, "range");
    assert.equal(review.target.working_tree, false);
    assert.deepEqual(review.files, ["src/a.ts"]);
    const symmetric = prepared(await cli(dir, "review", "--range", "main...feature"));
    assert.equal(symmetric.target.base, git(dir, "rev-parse", "main"));
    assert.equal(symmetric.diff_sha256, review.diff_sha256);
  });

  it("accepts a current, isolated record and renders it, with no gate or decision", async () => {
    const dir = repository();
    const review = prepared(await cli(dir, "review", "--base", "main"));
    const path = record(dir, review, { findings: [{ severity: "note", file: "src/b.ts", summary: "Unused export.", proof: { level: "reasoned" } }] });
    const checked = await cli(dir, "review", "--base", "main", "--evidence", path);
    assert.equal(checked.status, "success", JSON.stringify(checked.diagnostics));
    assert.equal(checked.decisions, undefined);
    const data = checked.data as { recorded: boolean; document: string; notes: unknown[] };
    assert.equal(data.recorded, true);
    assert.equal(data.notes.length, 1);
    assert.match(readFileSync(join(dir, data.document), "utf8"), /\*\*note\*\* `src\/b\.ts` \(reasoned\): Unused export\./);
  });

  it("requires the configured independent lenses in a standalone review bundle", async () => {
    const dir = repository();
    write(dir, ".paved/review.yaml", stringify({
      apiVersion: "paved/v1", kind: "ReviewPolicy", sensitive_paths: ["src/b.ts"],
    }));
    const review = prepared(await cli(dir, "review", "--base", "main"));
    const requiredLenses = (review as PreparedReview & { requiredLenses: string[] }).requiredLenses;
    assert.deepEqual(requiredLenses, ["Skeptic", "Architect", "Minimalist"]);

    const bundle = {
      apiVersion: "paved/v1",
      kind: "ChangeReviewBundle",
      target: review.target,
      reviewed: { diff_sha256: review.diff_sha256 },
      reviews: requiredLenses.map((lens, index) => ({
        reviewer: { agent: `reviewer ${index + 1}`, isolated: true, lens },
        passes: ["rules", "diff", "change"],
        findings: [],
      })),
    };
    write(dir, review.record, stringify(bundle));
    const accepted = await cli(dir, "review", "--base", "main", "--evidence", review.record);
    assert.equal(accepted.status, "success", JSON.stringify(accepted));

    write(dir, review.record, stringify({ ...bundle, reviews: bundle.reviews.slice(1) }));
    const missing = await cli(dir, "review", "--base", "main", "--evidence", review.record);
    assert.equal(missing.diagnostics[0]?.code, "PAVED_REVIEW_LENSES_INCOMPLETE");

    write(dir, review.record, stringify({ ...bundle, reviews: bundle.reviews.map((entry) => ({
      ...entry, reviewer: { ...entry.reviewer, agent: "same reviewer" },
    })) }));
    const duplicate = await cli(dir, "review", "--base", "main", "--evidence", review.record);
    assert.equal(duplicate.diagnostics[0]?.code, "PAVED_REVIEW_DUPLICATE_REVIEWER");
  });

  it("reports proven blocking findings as findings for the user to decide on", async () => {
    const dir = repository();
    const review = prepared(await cli(dir, "review", "--range", "main..feature"));
    const path = record(dir, review, { findings: [{ severity: "blocking", file: "src/a.ts", line: 1, summary: "Wrong constant.",
      proof: { level: "executed", command: "node -e 'process.exit(1)'", output_sha256: "a".repeat(64) } }] });
    const checked = await cli(dir, "review", "--range", "main..feature", "--evidence", path);
    assert.equal(checked.status, "warning");
    assert.equal(exitCode(checked), 1);
    assert.equal(checked.diagnostics[0]?.code, "PAVED_REVIEW_BLOCKING_FINDINGS");
  });

  it("refuses a stale, unproven, non-isolated or run-bound record", async () => {
    const dir = repository();
    const review = prepared(await cli(dir, "review", "--base", "main"));
    const unproven = record(dir, review, { findings: [{ severity: "blocking", file: "src/a.ts", summary: "Looks wrong.", proof: { level: "reasoned" } }] });
    assert.equal((await cli(dir, "review", "--base", "main", "--evidence", unproven)).diagnostics[0]?.code, "PAVED_REVIEW_FINDING_UNPROVEN");
    const shared = record(dir, review, { reviewer: { agent: "author", isolated: false } });
    assert.equal((await cli(dir, "review", "--base", "main", "--evidence", shared)).diagnostics[0]?.code, "PAVED_REVIEW_NOT_INDEPENDENT");
    const current = record(dir, review);
    write(dir, "src/b.ts", "export const b = 2;\n");
    const stale = await cli(dir, "review", "--base", "main", "--evidence", current);
    assert.equal(stale.status, "failed");
    assert.equal(stale.diagnostics[0]?.code, "PAVED_REVIEW_STALE");
    write(dir, review.record, stringify({
      apiVersion: "paved/v1", kind: "ChangeReview", run: "intent-0123456789abcdef0123", reviewer: { agent: "r", isolated: true },
      reviewed: { plan_sha256: "a".repeat(64), source_sha256: "a".repeat(64), evidence_sha256: "a".repeat(64) }, passes: ["diff"], findings: [],
    }));
    assert.equal((await cli(dir, "review", "--base", "main", "--evidence", review.record)).diagnostics[0]?.code, "PAVED_REVIEW_RECORD_INVALID");
  });

  it("refuses an unclear target, an empty change and an uninitialized repository", async () => {
    const dir = repository();
    assert.equal((await cli(dir, "review")).diagnostics[0]?.code, "PAVED_REVIEW_TARGET_INVALID");
    assert.equal((await cli(dir, "review", "--base", "main", "--range", "main..feature")).diagnostics[0]?.code, "PAVED_REVIEW_TARGET_INVALID");
    assert.equal((await cli(dir, "review", "--base", "no-such-ref")).diagnostics[0]?.code, "PAVED_REVIEW_TARGET_INVALID");
    assert.equal((await cli(dir, "review", "--range", "main")).diagnostics[0]?.code, "PAVED_REVIEW_TARGET_INVALID");
    assert.equal((await cli(dir, "review", "--range", "main..main")).diagnostics[0]?.code, "PAVED_REVIEW_TARGET_INVALID");
    assert.equal((await cli(dir, "status", "--range", "main..feature")).diagnostics[0]?.code, "PAVED_CLI_USAGE");
    const bare = temporaryDirectory("paved-review-bare");
    git(bare, "init", "-q");
    assert.equal((await cli(bare, "review", "--base", "main")).diagnostics[0]?.code, "PAVED_REVIEW_UNINITIALIZED");
    assert.equal(existsSync(join(bare, ".paved")), false);
  });
});
