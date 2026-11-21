import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { loadRuleCatalog, ruleCovers, type CatalogRule } from "./rule-catalog.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";
import { collectChange, commitRangeChange, mergeBase, resolveCommit, type ChangeDiff } from "./workflow-evidence.ts";
import { findingLocation, provesBlocking, type ChangeReview, type ReviewFinding } from "./workflow-gates/review.ts";
import { reviewBundleProblem, type ChangeReviewBundle, type ReviewLens } from "./review-bundle.ts";
import { planReview } from "./review-plan.ts";
import { reviewChange, reviewCommitRange } from "./review-change.ts";

/** The change a review outside a workflow run covers. */
export interface ReviewTarget {
  readonly kind: "base" | "range";
  readonly ref: string;
  readonly base: string;
  readonly head: string;
  readonly working_tree: boolean;
}

export interface PreparedReview {
  readonly id: string;
  readonly target: ReviewTarget;
  readonly files: readonly string[];
  readonly diff: string;
  readonly diff_sha256: string;
  readonly brief: string;
  readonly record: string;
  readonly rules: readonly { id: string; path: string }[];
  readonly requiredLenses: readonly ReviewLens[];
}

export class ReviewTargetError extends Error {}

export type TargetedChangeReview =
  | (Omit<ChangeReview, "run" | "reviewed"> & { readonly target: ReviewTarget; readonly reviewed: { readonly diff_sha256: string } })
  | (Omit<ChangeReviewBundle, "run" | "reviewed"> & { readonly target: ReviewTarget; readonly reviewed: { readonly diff_sha256: string } });

/** Why a recorded review does not count for the change as it is now; empty when it does. */
export interface ReviewCheck {
  readonly problems: readonly { code: string; message: string; remediation: string }[];
  readonly blocking: readonly ReviewFinding[];
  readonly notes: readonly ReviewFinding[];
  readonly document?: string;
}

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const DIR = ".paved/generated/reviews";

function change(sourceRoot: string, request: { base?: string; range?: string }): { target: ReviewTarget; diff: ChangeDiff } {
  if ((request.base === undefined) === (request.range === undefined)) throw new ReviewTargetError("Name the change to review with exactly one of --base <ref> or --range <a..b>.");
  const head = resolveCommit(sourceRoot, "HEAD");
  if (request.base !== undefined) {
    const target = resolveCommit(sourceRoot, request.base);
    if (target === undefined) throw new ReviewTargetError(`${request.base} is not a revision in this repository.`);
    if (head === undefined) throw new ReviewTargetError("The repository has no commit to review against.");
    const base = mergeBase(sourceRoot, "HEAD", target);
    if (base === undefined) throw new ReviewTargetError(`HEAD and ${request.base} share no history.`);
    const diff = collectChange(sourceRoot, base);
    if (diff === undefined) throw new ReviewTargetError("The project is not a Git working tree.");
    const committed = commitRangeChange(sourceRoot, base, head).patch;
    return { target: { kind: "base", ref: request.base, base, head, working_tree: diff.patch !== committed }, diff };
  }
  const parts = /^(.+?)(\.\.\.?)(.+)$/.exec(request.range!);
  if (parts === null) throw new ReviewTargetError(`${request.range} is not a range; use <from>..<to> or <from>...<to>.`);
  const from = resolveCommit(sourceRoot, parts[1]!);
  const to = resolveCommit(sourceRoot, parts[3]!);
  if (from === undefined || to === undefined) throw new ReviewTargetError(`${from === undefined ? parts[1] : parts[3]} is not a revision in this repository.`);
  const base = parts[2] === "..." ? mergeBase(sourceRoot, from, to) : from;
  if (base === undefined) throw new ReviewTargetError(`${parts[1]} and ${parts[3]} share no history.`);
  return { target: { kind: "range", ref: request.range!, base, head: to, working_tree: false }, diff: commitRangeChange(sourceRoot, base, to) };
}

/** Stable while the target's base stays put, so the brief and record paths survive further work on it. */
function reviewId(target: ReviewTarget): string {
  return `review-${sha(JSON.stringify([target.kind, target.base, target.kind === "range" ? target.head : target.ref])).slice(0, 20)}`;
}

export const standaloneRecordPath = (id: string): string => `${DIR}/${id}-findings.yaml`;

function write(projectRoot: string, relative: string, content: string): string {
  const path = resolveSafePath(projectRoot, relative);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, content);
  return relative;
}

function brief(review: Omit<PreparedReview, "brief">, rules: readonly CatalogRule[]): string {
  const { target } = review;
  return [
    `# Review brief for ${review.id}`, "",
    "You are reviewing a change you did not write. Work only from the files below, not from the",
    "conversation that produced the change, and do not edit anything except your findings file.",
    "No workflow run stands behind this change: there is no approved plan or evidence record, so",
    "judge it against the commit messages and the code, and say so where intent is unclear.", "",
    `- Target: ${target.kind === "base" ? `everything changed since the merge base with \`${target.ref}\`` : `the commits in \`${target.ref}\``}`,
    `- Base: \`${target.base}\``,
    `- Head: \`${target.head}\`${target.working_tree ? " plus uncommitted and untracked files" : ""}`,
    `- Diff: \`${review.diff}\` (${review.files.length} ${review.files.length === 1 ? "file" : "files"})`,
    ...(target.base === target.head ? [] : [`- Commit messages: \`git log --format=%B ${target.base}..${target.head}\``]),
    `- Rules in scope: ${rules.length ? rules.map((rule) => `\`${rule.id}\` (\`${rule.path}\`)`).join(", ") : "none"}`, "",
    "Follow the change-review skill: run the rules, diff and change passes, then keep only",
    "findings you validated against the code. Take each one as far down the proof ladder as is cheap:",
    "asserted, cited (file:line or library source), reasoned (the failure walked step by step),",
    "executed (a command running the real code shows it) or reproduced (shown in the running system).",
    "Only an executed or reproduced finding may be blocking, with the command you ran and the SHA-256",
    "of its captured output; Paved refuses a blocking finding with weaker proof. Record the rest as",
    "notes. Merge findings that share a root cause. Use `findings: []` when nothing survives.",
    "When a blocking finding breaks an in-scope rule, name it in `rule`.", "",
    `Write your findings to \`${review.record}\`:`, "",
    "```yaml",
    "apiVersion: paved/v1",
    "kind: ChangeReviewBundle",
    "target:",
    `  kind: ${target.kind}`,
    `  ref: ${JSON.stringify(target.ref)}`,
    `  base: ${target.base}`,
    `  head: ${target.head}`,
    `  working_tree: ${target.working_tree}`,
    "reviewed:",
    `  diff_sha256: ${review.diff_sha256}`,
    "reviews:",
    ...review.requiredLenses.flatMap((lens) => [
      `  - reviewer: { agent: <distinct agent and model>, isolated: true, lens: ${lens} }`,
      "    passes: [rules, diff, change]",
      "    findings: []",
    ]),
    "```", "",
  ].join("\n");
}

/**
 * Prepares a review of a commit range or of everything changed since a base ref, with no
 * workflow run: writes the diff and a brief for an isolated reviewer under
 * .paved/generated/reviews/. Rules in scope are the Core and project rules whose paths
 * cover a changed file.
 */
export function prepareStandaloneReview(input: {
  projectRoot: string; sourceRoot: string; coreRoot: string; base?: string; range?: string; sensitivePatterns?: readonly string[];
}): PreparedReview {
  const { target, diff } = change(input.sourceRoot, input);
  if (diff.patch.trim() === "") throw new ReviewTargetError(`${target.kind === "base" ? `Nothing changed since the merge base with ${target.ref}` : `The range ${target.ref} changes nothing`} outside Paved state.`);
  const id = reviewId(target);
  const rules = loadRuleCatalog({ projectRoot: input.projectRoot, coreRoot: input.coreRoot }).filter((rule) => ruleCovers(rule, diff.files));
  const reviewFiles = target.kind === "base"
    ? reviewChange(input.sourceRoot, target.base)
    : reviewCommitRange(input.sourceRoot, target.base, target.head);
  const planned = planReview(reviewFiles, input.sensitivePatterns === undefined ? {} : { sensitivePatterns: input.sensitivePatterns });
  const requiredLenses: ReviewLens[] = planned.reviewers.length > 0
    ? planned.reviewers.map((reviewer) => reviewer.lens)
    : ["Skeptic"];
  const diffPath = write(input.projectRoot, `${DIR}/${id}.diff`, diff.patch);
  const prepared = {
    id, target, files: diff.files, diff: diffPath, diff_sha256: sha(diff.patch), record: standaloneRecordPath(id),
    rules: rules.map((rule) => ({ id: rule.id, path: rule.path })), requiredLenses,
  };
  return { ...prepared, brief: write(input.projectRoot, `${DIR}/${id}-brief.md`, brief(prepared, rules)) };
}

const sameTarget = (a: ReviewTarget, b: ReviewTarget): boolean =>
  a.kind === b.kind && a.ref === b.ref && a.base === b.base && a.head === b.head && a.working_tree === b.working_tree;

function findingLine(finding: ReviewFinding): string {
  const proof = finding.proof;
  return `- **${finding.severity}** \`${findingLocation(finding)}\`${proof ? ` (${proof.level}${proof.command ? `: \`${proof.command}\`` : ""})` : ""}: ${finding.summary}${finding.rule ? ` Rule: \`${finding.rule}\`.` : ""}${proof?.expected ? ` Expected: ${proof.expected}` : ""}`;
}

/**
 * Checks a reviewer's record against the change as it is now, with the rules the workflow
 * review gate applies: valid schema, the same target and diff, an isolated reviewer, and
 * executed or reproduced proof for every blocking finding. A record that counts is
 * rendered next to it as Markdown. Nothing else is written and no workflow state changes.
 */
export function checkStandaloneReview(input: { projectRoot: string; coreRoot: string; prepared: PreparedReview; record: string }): ReviewCheck {
  const resume = `paved review ${input.prepared.target.kind === "base" ? `--base ${input.prepared.target.ref}` : `--range ${input.prepared.target.ref}`} --evidence ${input.record} --json`;
  const fail = (code: string, message: string, remediation: string): ReviewCheck => ({ problems: [{ code, message, remediation }], blocking: [], notes: [] });
  const path = resolveSafePath(input.projectRoot, input.record);
  if (!existsSync(path)) return fail("PAVED_REVIEW_RECORD_REQUIRED", `${input.record} does not exist.`, `Let an isolated reviewer write it from ${input.prepared.brief}, then run ${resume}.`);
  let record: TargetedChangeReview & { run?: string };
  try { record = loadYaml(path) as typeof record; } catch { return fail("PAVED_REVIEW_RECORD_INVALID", `${input.record} is not valid YAML.`, `Write the findings in the format ${input.prepared.brief} shows.`); }
  const schema = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]).validate(record);
  if (!schema.valid) return fail("PAVED_REVIEW_RECORD_INVALID", schema.errors.join("; "), `Write the findings in the format ${input.prepared.brief} shows, then run ${resume}.`);
  if (record.target === undefined) return fail("PAVED_REVIEW_RECORD_INVALID", `${input.record} reviews run ${record.run}, not a target.`, `Review ${input.prepared.target.ref} from ${input.prepared.brief}.`);
  if (!sameTarget(record.target, input.prepared.target)) {
    return fail("PAVED_REVIEW_STALE", `The review covers ${record.target.kind} ${record.target.ref} at ${record.target.head}, not the change as it is now.`, `Review the current change again from ${input.prepared.brief}, then run ${resume}.`);
  }
  if (record.reviewed.diff_sha256 !== input.prepared.diff_sha256) {
    return fail("PAVED_REVIEW_STALE", "The review read a different diff than the change has now.", `Paved rewrote ${input.prepared.brief} with the current digest. Review the current change again from it, then run ${resume}.`);
  }
  const reviewEntries = record.kind === "ChangeReviewBundle"
    ? record.reviews
    : [{ reviewer: { ...record.reviewer, lens: "Skeptic" as const }, passes: record.passes, findings: record.findings }];
  const requiredLenses = input.prepared.requiredLenses;
  if (record.kind === "ChangeReviewBundle") {
    const problem = reviewBundleProblem(record.reviews, requiredLenses);
    if (problem) return fail(problem.code, problem.message, `Collect one isolated review per required lens from ${input.prepared.brief}, then run ${resume}.`);
  } else if (requiredLenses.length !== 1 || requiredLenses[0] !== "Skeptic") {
    return fail("PAVED_REVIEW_LENSES_INCOMPLETE", `This change requires independent review lenses: ${requiredLenses.join(", ")}.`,
      `Collect one isolated review per required lens in a ChangeReviewBundle from ${input.prepared.brief}, then run ${resume}.`);
  }
  if (reviewEntries.some((entry) => !entry.reviewer.isolated)) {
    return fail("PAVED_REVIEW_NOT_INDEPENDENT", "The review was not made by an isolated reviewer, so it checks the change against the reasoning that produced it.",
      `Run the review in a subagent with its own context that sees only ${input.prepared.brief}, then run ${resume}.`);
  }
  const findings = reviewEntries.flatMap((entry) => entry.findings);
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const unproven = blocking.filter((finding) => !provesBlocking(finding.proof));
  if (unproven.length) {
    return fail("PAVED_REVIEW_FINDING_UNPROVEN",
      `A blocking finding needs proof at level executed or reproduced: ${unproven.map((finding) => `${findingLocation(finding)} (${finding.proof?.level ?? "no proof"})`).join(", ")}.`.slice(0, 2000),
      `Prove each one with a command that runs the real code and record proof.level, proof.command and proof.output_sha256, or record it as severity note; then run ${resume}.`);
  }
  const notes = findings.filter((finding) => finding.severity !== "blocking");
  const { target } = input.prepared;
  const document = write(input.projectRoot, `${DIR}/${input.prepared.id}.md`, [
    `# Review of ${target.ref}`, "",
    "Generated from the reviewer's record; the record stays the source of truth. No workflow run was involved.", "",
    `- Target: ${target.kind} \`${target.ref}\`, \`${target.base.slice(0, 12)}\`..\`${target.head.slice(0, 12)}\`${target.working_tree ? " plus uncommitted and untracked files" : ""}`,
    `- Diff: \`${input.prepared.diff}\` (sha256 \`${input.prepared.diff_sha256}\`)`,
    `- Record: \`${input.record}\``,
    `- Reviewers: ${reviewEntries.map((entry) => `${entry.reviewer.agent}${"lens" in entry.reviewer ? ` (${entry.reviewer.lens})` : ""}`).join(", ")}.`,
    `- Passes: ${[...new Set(reviewEntries.flatMap((entry) => entry.passes))].join(", ")}.`,
    `- Rules in scope: ${input.prepared.rules.length ? input.prepared.rules.map((rule) => `\`${rule.id}\``).join(", ") : "none"}`, "",
    "## Findings", "", ...(findings.length ? [...blocking, ...notes].map(findingLine) : ["No findings."]), "",
  ].join("\n"));
  return { problems: [], blocking, notes, document };
}
