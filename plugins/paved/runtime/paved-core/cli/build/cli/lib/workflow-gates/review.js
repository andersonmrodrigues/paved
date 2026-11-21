import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "../documents.js";
import { resolveSafePath } from "../safe-path.js";
import { createRegistry } from "../schemas.js";
import { reviewChange } from "../review-change.js";
import { planReview } from "../review-plan.js";
import { loadReviewSensitivePatterns } from "../review-policy.js";
import { reviewBundleProblem } from "../review-bundle.js";
import { REVIEW_FIX, REVIEW_HANDLER, SOURCE_CHANGED_AFTER_VERIFICATION } from "../workflows.js";
import { runSourceRoot } from "../workflow-runs.js";
import { blocked, fingerprint, now, projectRelative, reopenImplementation, sha, sourceChangedAction, sourceMovedSinceVerification } from "./shared.js";
export const reviewBriefPath = (runId) => `.paved/generated/reviews/${runId}-brief.md`;
export const reviewRecordPath = (runId) => `.paved/generated/reviews/${runId}-findings.yaml`;
/** The command that hands the reviewer's findings to the review gate. */
export const reviewRecordCommand = (runId) => `paved execute --run ${runId} --auto --evidence ${reviewRecordPath(runId)} --json`;
/**
 * Refusals that leave the run without a review record it can accept. Each one returns the
 * `review` block, so the agent has the brief, the routing and the record command at hand.
 */
export const REVIEW_RECORD_CODES = new Set([
    "PAVED_REVIEW_RECORD_REQUIRED", "PAVED_REVIEW_RECORD_INVALID", "PAVED_REVIEW_NOT_INDEPENDENT",
    "PAVED_REVIEW_STALE", "PAVED_REVIEW_FINDING_UNPROVEN", "PAVED_REVIEW_DUPLICATE_REVIEWER",
    "PAVED_REVIEW_LENSES_INCOMPLETE",
]);
export const planRef = (run) => run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
/** What a review must have read to count for the run as it is now. */
export function reviewedState(projectRoot, run) {
    const plan = planRef(run);
    if (!plan || !run.evidence)
        return undefined;
    const planPath = resolveSafePath(projectRoot, plan);
    const evidencePath = resolveSafePath(projectRoot, run.evidence);
    if (!existsSync(planPath) || !existsSync(evidencePath))
        return undefined;
    return { plan_sha256: sha(readFileSync(planPath)), source_sha256: fingerprint(runSourceRoot(projectRoot, run)), evidence_sha256: sha(readFileSync(evidencePath)) };
}
/** A blocking finding holds the change only when a command or the running system showed it. */
export const provesBlocking = (proof) => proof?.level === "executed" || proof?.level === "reproduced";
/** Where a finding points, as `file` or `file:line`. */
export function findingLocation(finding) {
    return `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
}
const STATE_NAMES = { plan_sha256: "plan", source_sha256: "source", evidence_sha256: "evidence" };
export function requiredReviewLenses(projectRoot, coreRoot, run) {
    let sensitivePatterns;
    try {
        sensitivePatterns = loadReviewSensitivePatterns(projectRoot, coreRoot);
    }
    catch {
        return ["Skeptic", "Architect", "Minimalist"];
    }
    try {
        const revision = run.revision === "unversioned" ? undefined : run.revision;
        return planReview(reviewChange(runSourceRoot(projectRoot, run), revision), { sensitivePatterns })
            .reviewers.map((reviewer) => reviewer.lens);
    }
    catch {
        return ["Skeptic", "Architect", "Minimalist"];
    }
}
/**
 * The review counts only when a reviewer that did not write the change read the run's
 * current plan, source and evidence. A blocking finding must have been executed or
 * reproduced; the rest are notes. Blocking findings go back to the user: fixing one
 * reopens implementation, so the fix is tested, verified and reviewed again.
 */
export const review = (context) => {
    const { run, projectRoot } = context;
    if (sourceMovedSinceVerification(projectRoot, run)) {
        const nextAction = sourceChangedAction(projectRoot, run);
        reopenImplementation(run, SOURCE_CHANGED_AFTER_VERIFICATION);
        return { kind: "wait", nextAction };
    }
    const expected = reviewedState(projectRoot, run);
    if (!expected)
        return blocked("PAVED_REVIEW_STATE_MISSING", "The review needs the approved plan and the run's recorded evidence.", "Complete the evidence phase before the review.");
    const brief = reviewBriefPath(run.id);
    const resume = reviewRecordCommand(run.id);
    const requiredLenses = requiredReviewLenses(projectRoot, context.coreRoot, run);
    if (requiredLenses.length === 0)
        return { kind: "pass" };
    if (!context.evidence) {
        return blocked("PAVED_REVIEW_RECORD_REQUIRED", `The review phase needs isolated evidence for these lenses: ${requiredLenses.join(", ")}.`, `Start a subagent with its own context, at the capacity and effort in review.independent.routing, and give it only ${brief}. `
            + `Each reviewer records its assigned lens in ${reviewRecordPath(run.id)}; use a ChangeReviewBundle with distinct reviewer identities. `
            + `You do not review the change yourself. Then record the findings with ${resume}.`);
    }
    const raw = loadYaml(context.evidence);
    const schema = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]).validate(raw);
    if (!schema.valid)
        return blocked("PAVED_REVIEW_RECORD_INVALID", schema.errors.join("; "), `Write the findings in the format ${brief} shows, then run ${resume}.`);
    if (raw.run !== run.id) {
        return blocked("PAVED_REVIEW_RECORD_INVALID", raw.run === undefined ? `The review is of a change outside a run (paved review), not of run ${run.id}.` : `The review is for run ${raw.run}, not ${run.id}.`, `Have the reviewer review run ${run.id} from ${brief}, then run ${resume}.`);
    }
    let reviewEntries;
    if (raw.kind === "ChangeReviewBundle") {
        const problem = reviewBundleProblem(raw.reviews, requiredLenses);
        if (problem)
            return blocked(problem.code, problem.message, `Collect one isolated review per required lens from ${brief}, using a distinct reviewer identity for each, then run ${resume}.`);
        reviewEntries = raw.reviews;
    }
    else {
        if (requiredLenses.length !== 1 || requiredLenses[0] !== "Skeptic") {
            return blocked("PAVED_REVIEW_LENSES_INCOMPLETE", `This change requires independent review lenses: ${requiredLenses.join(", ")}.`, `Collect one isolated review per required lens in a ChangeReviewBundle from ${brief}, then run ${resume}.`);
        }
        if (!raw.reviewer.isolated) {
            return blocked("PAVED_REVIEW_NOT_INDEPENDENT", "The review was not made by an isolated reviewer, so it checks the change against the reasoning that produced it.", `Run the review in a subagent with its own context that sees only ${brief}, then run ${resume}.`);
        }
        reviewEntries = [raw];
    }
    const reviewed = raw.reviewed;
    const stale = Object.keys(STATE_NAMES).filter((key) => reviewed[key] !== expected[key]);
    if (stale.length) {
        return blocked("PAVED_REVIEW_STALE", `The review read a different ${stale.map((key) => STATE_NAMES[key]).join(", ")} than the run has now. When a verification fingerprint is available, the source still matches it.`, `Paved rewrote ${brief} with the current digests. Review the current change again from it, then run ${resume}.${stale.includes("source_sha256")
            ? " The source digest covers every source and test file in the checkout, so a file an editor, build or generator wrote since the review counts too."
            : ""}`);
    }
    const ref = projectRelative(projectRoot, context.evidence);
    const digest = sha(readFileSync(context.evidence));
    const findings = reviewEntries.flatMap((entry) => entry.findings);
    const blocking = findings.filter((finding) => finding.severity === "blocking");
    const notes = findings.length - blocking.length;
    const answer = run.decisions?.findLast((decision) => decision.handler === REVIEW_HANDLER && decision.status === "APPLIED"
        && decision.evidence.some((item) => item.sha256 === digest))?.answer;
    // A record the user already decided on keeps that decision, so a run in flight is not sent back.
    const unproven = answer === undefined ? blocking.filter((finding) => !provesBlocking(finding.proof)) : [];
    if (unproven.length) {
        const listed = unproven.map((finding) => `${findingLocation(finding)} (${finding.proof?.level ?? "no proof"})`).join(", ");
        return blocked("PAVED_REVIEW_FINDING_UNPROVEN", `A blocking finding needs proof at level executed or reproduced: ${listed}.`.slice(0, 2000), `Prove each one with a command that runs the real code and record proof.level, proof.command and proof.output_sha256, or record it as severity note; then run ${resume}.`);
    }
    const rules = [...new Set(blocking.flatMap((finding) => finding.rule === undefined ? [] : [finding.rule]))].sort();
    const reviewers = reviewEntries.map((entry) => entry.reviewer.agent).join(", ");
    // Kept on the run because the next review overwrites the findings file; the Gardener reads it as a human correction.
    const recorded = (outcome) => ({
        at: now(), type: "evidence-recorded", phase: "review", ref,
        detail: `sha256=${digest}; reviewers=${reviewers.replaceAll(";", ",")}; blocking=${blocking.length}${outcome}; notes=${notes}${rules.length ? `; rules=${rules.join(",")}` : ""}`.slice(0, 4000),
    });
    let accepted = false;
    if (blocking.length) {
        if (answer === "fix") {
            run.events.push(recorded(" (fix)"));
            reopenImplementation(run, REVIEW_FIX);
            return { kind: "wait", nextAction: `Fix the blocking findings in ${ref}, then run paved execute --run ${run.id} --auto --note <what was fixed> --json; tests, verification, evidence and a new independent review follow.` };
        }
        if (answer !== "accept") {
            return {
                kind: "ask",
                nextAction: `Present the findings and ask the user, then resume with paved execute --run ${run.id} --auto --evidence ${ref} --answer <id>=<value> --answered-by <you> --json.`,
                candidate: {
                    scope: "run",
                    question: `The independent review found ${blocking.length} blocking ${blocking.length === 1 ? "finding" : "findings"}. How should Paved continue?`,
                    reason: blocking.map((finding) => `${findingLocation(finding)} [${finding.proof?.level ?? "unproven"}]: ${finding.summary}`).join(" ").slice(0, 2000),
                    options: [
                        { id: "fix", label: "Fix them", description: "Go back to implementation and fix the findings.", consequence: "The fix is tested, verified and reviewed again before the run completes." },
                        { id: "accept", label: "Accept as they are", description: "Complete the run with the findings unresolved.", consequence: "The findings stay on record as accepted by you." },
                    ],
                    recommended: "fix",
                    evidence: [{ type: "file", location: ref, sha256: digest }],
                    required: true, requiredAnswer: { type: "single-choice" }, effect: "record-only", handler: REVIEW_HANDLER,
                    candidates: ["fix", "accept"],
                },
            };
        }
        accepted = true;
    }
    run.events.push(recorded(accepted ? " (accepted)" : ""));
    return { kind: "pass" };
};
