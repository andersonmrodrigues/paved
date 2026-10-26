import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "../documents.ts";
import { resolveSafePath } from "../safe-path.ts";
import { createRegistry } from "../schemas.ts";
import { REVIEW_FIX, REVIEW_HANDLER } from "../workflows.ts";
import { runSourceRoot, type Run } from "../workflow-runs.ts";
import type { PhaseHook } from "./index.ts";
import { blocked, fingerprint, now, projectRelative, reopenImplementation, sha } from "./shared.ts";

export interface ReviewedState { readonly plan_sha256: string; readonly source_sha256: string; readonly evidence_sha256: string }
export interface ReviewFinding { readonly severity: "blocking" | "note"; readonly file: string; readonly line?: number; readonly summary: string }
export interface ChangeReview {
  readonly run: string;
  readonly reviewer: { readonly agent: string; readonly isolated: boolean };
  readonly reviewed: ReviewedState;
  readonly passes: readonly string[];
  readonly findings: readonly ReviewFinding[];
}

export const reviewBriefPath = (runId: string): string => `.paved/generated/reviews/${runId}-brief.md`;
export const reviewRecordPath = (runId: string): string => `.paved/generated/reviews/${runId}-findings.yaml`;
export const planRef = (run: Run): string | undefined => run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;

/** What a review must have read to count for the run as it is now. */
export function reviewedState(projectRoot: string, run: Run): ReviewedState | undefined {
  const plan = planRef(run);
  if (!plan || !run.evidence) return undefined;
  const planPath = resolveSafePath(projectRoot, plan);
  const evidencePath = resolveSafePath(projectRoot, run.evidence);
  if (!existsSync(planPath) || !existsSync(evidencePath)) return undefined;
  return { plan_sha256: sha(readFileSync(planPath)), source_sha256: fingerprint(runSourceRoot(projectRoot, run)), evidence_sha256: sha(readFileSync(evidencePath)) };
}

const STATE_NAMES: Readonly<Record<keyof ReviewedState, string>> = { plan_sha256: "plan", source_sha256: "source", evidence_sha256: "evidence" };

/**
 * The review counts only when a reviewer that did not write the change read the run's
 * current plan, source and evidence. Blocking findings go back to the user: fixing one
 * reopens implementation, so the fix is tested, verified and reviewed again.
 */
export const review: PhaseHook = (context) => {
  const { run, projectRoot } = context;
  const expected = reviewedState(projectRoot, run);
  if (!expected) return blocked("PAVED_REVIEW_STATE_MISSING", "The review needs the approved plan and the run's recorded evidence.", "Complete the evidence phase before the review.");
  const brief = reviewBriefPath(run.id);
  const resume = `paved execute --run ${run.id} --auto --evidence ${reviewRecordPath(run.id)} --json`;
  if (!context.evidence) {
    return blocked("PAVED_REVIEW_RECORD_REQUIRED", "The review phase needs findings from a reviewer that did not write the change.",
      `Start a subagent with its own context, give it only ${brief}, let it write ${reviewRecordPath(run.id)}, then run ${resume}.`);
  }
  const record = loadYaml(context.evidence) as ChangeReview;
  const schema = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]).validate(record);
  if (!schema.valid) return blocked("PAVED_REVIEW_RECORD_INVALID", schema.errors.join("; "), `Write the findings in the format ${brief} shows, then run ${resume}.`);
  if (record.run !== run.id) return blocked("PAVED_REVIEW_RECORD_INVALID", `The review is for run ${record.run}, not ${run.id}.`, `Review run ${run.id} from ${brief}.`);
  if (!record.reviewer.isolated) {
    return blocked("PAVED_REVIEW_NOT_INDEPENDENT", "The review was not made by an isolated reviewer, so it checks the change against the reasoning that produced it.",
      `Run the review in a subagent with its own context that sees only ${brief}, then run ${resume}.`);
  }
  const stale = (Object.keys(STATE_NAMES) as (keyof ReviewedState)[]).filter((key) => record.reviewed[key] !== expected[key]);
  if (stale.length) {
    return blocked("PAVED_REVIEW_STALE", `The review read a different ${stale.map((key) => STATE_NAMES[key]).join(", ")} than the run has now.`,
      `Review the current change again from ${brief}, which carries the current digests, then run ${resume}.`);
  }

  const ref = projectRelative(projectRoot, context.evidence);
  const digest = sha(readFileSync(context.evidence));
  const blocking = record.findings.filter((finding) => finding.severity === "blocking");
  const notes = record.findings.length - blocking.length;
  let accepted = false;
  if (blocking.length) {
    const answer = run.decisions?.findLast((decision) => decision.handler === REVIEW_HANDLER && decision.status === "APPLIED"
      && decision.evidence.some((item) => item.sha256 === digest))?.answer;
    if (answer === "fix") {
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
          reason: blocking.map((finding) => `${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.summary}`).join(" ").slice(0, 2000),
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
  run.events.push({
    at: now(), type: "evidence-recorded", phase: "review", ref,
    detail: `sha256=${digest}; reviewer=${record.reviewer.agent}; blocking=${blocking.length}${accepted ? " (accepted)" : ""}; notes=${notes}`.slice(0, 4000),
  });
  return { kind: "pass" };
};
