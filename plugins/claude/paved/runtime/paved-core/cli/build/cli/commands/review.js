import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkStandaloneReview, prepareStandaloneReview, ReviewTargetError } from "../lib/standalone-review.js";
import { projectRelative } from "../lib/workflow-gates/shared.js";
import { resolveConsumerPath } from "../lib/safe-path.js";
import { reviewChange } from "../lib/review-change.js";
import { planReview } from "../lib/review-plan.js";
import { loadReviewSensitivePatterns, ReviewPolicyError } from "../lib/review-policy.js";
import { createDiagnostic, createResult } from "../result.js";
/**
 * `paved review --base <ref> | --range <a..b> [--evidence <record>]`: the change-review of a
 * change made outside a workflow run. Without --evidence it writes the diff and the brief
 * for an isolated reviewer; with it, it checks the reviewer's record against the change as
 * it is now. No run, gate or decision is involved.
 */
export function reviewHandler(invocation) {
    const { projectRoot, sourceRoot, coreRoot } = invocation.paths;
    const { base, range, evidence } = invocation.flags;
    if (!existsSync(join(projectRoot, ".paved/manifest.yaml"))) {
        return createResult({ command: "review", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "config", code: "PAVED_REVIEW_UNINITIALIZED", component: "review",
                    message: "Paved is not initialized in this repository, so there are no project rules to review against.",
                    remediation: "Initialize Paved with paved init, then run paved review again.",
                })] });
    }
    try {
        let sensitivePatterns;
        try {
            sensitivePatterns = loadReviewSensitivePatterns(projectRoot, coreRoot);
        }
        catch (error) {
            if (!(error instanceof ReviewPolicyError))
                throw error;
            return createResult({ command: "review", status: "failed", diagnostics: [createDiagnostic({
                        severity: "error", category: "config", code: "PAVED_REVIEW_POLICY_INVALID", component: "review",
                        message: error.message,
                        remediation: "Fix .paved/review.yaml before planning review.",
                    })] });
        }
        if (invocation.selectors.length > 0) {
            if (invocation.selectors.length !== 1 || invocation.selectors[0] !== "plan" || range !== undefined || evidence !== undefined) {
                throw new ReviewTargetError("Use review plan with an optional --base, or review with --base or --range and optional --evidence.");
            }
            let files;
            try {
                files = reviewChange(sourceRoot, base);
            }
            catch (error) {
                throw new ReviewTargetError(error instanceof Error ? error.message : "Cannot determine the review change.");
            }
            return createResult({ command: "review", status: "success", data: {
                    plan: planReview(files, { sensitivePatterns }), files, base: base ?? "HEAD", includesWorkingTree: true,
                } });
        }
        const prepared = prepareStandaloneReview({
            projectRoot, sourceRoot, coreRoot, sensitivePatterns,
            ...(base === undefined ? {} : { base }), ...(range === undefined ? {} : { range }),
        });
        if (evidence === undefined) {
            return createResult({ command: "review", status: "success", data: { review: prepared, recorded: false, nextAction: `Start a subagent with its own context, give it only ${prepared.brief}, let it write ${prepared.record}, then run paved review ${base === undefined ? `--range ${range}` : `--base ${base}`} --evidence ${prepared.record} --json.` } });
        }
        const record = projectRelative(projectRoot, resolveConsumerPath(projectRoot, sourceRoot, evidence));
        const check = checkStandaloneReview({ projectRoot, coreRoot, prepared, record });
        if (check.problems.length > 0) {
            return createResult({ command: "review", status: "failed", data: { review: prepared, recorded: false },
                diagnostics: check.problems.map((problem) => createDiagnostic({ severity: "error", category: "verification", component: "review", ...problem })) });
        }
        return createResult({
            command: "review", status: check.blocking.length > 0 ? "warning" : "success",
            data: { review: prepared, recorded: true, record, document: check.document, blocking: check.blocking, notes: check.notes },
            diagnostics: check.blocking.length > 0 ? [createDiagnostic({
                    severity: "warning", category: "findings", code: "PAVED_REVIEW_BLOCKING_FINDINGS", component: "review",
                    message: `The independent review found ${check.blocking.length} blocking ${check.blocking.length === 1 ? "finding" : "findings"}; see ${check.document}.`,
                    remediation: "Present the findings to the user, who decides whether to fix them or accept them as they are.",
                })] : [],
        });
    }
    catch (error) {
        if (!(error instanceof ReviewTargetError))
            throw error;
        return createResult({ command: "review", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_REVIEW_TARGET_INVALID", component: "review", message: error.message,
                })] });
    }
}
