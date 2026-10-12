import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadYaml } from "./documents.js";
import { intentDocumentPath } from "./intent.js";
import { resolveSafePath } from "./safe-path.js";
import { planRef, reviewBriefPath, reviewedState, reviewRecordPath } from "./workflow-gates/review.js";
export function reviewBlock(target, companions = [], independent) {
    return { target, preview: `paved preview start ${target} --json`, companions, ...(independent ? { independent } : {}) };
}
/** Markdown documents of the same run under .paved/documents/, other than `exclude`. */
export function companionDocuments(projectRoot, runId, exclude) {
    const root = join(projectRoot, ".paved/documents");
    if (!existsSync(root))
        return [];
    return readdirSync(root, { withFileTypes: true }).filter((kind) => kind.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((kind) => readdirSync(join(root, kind.name), { withFileTypes: true })
        .filter((file) => file.isFile() && file.name.endsWith(".md") && (file.name === `${runId}.md` || file.name.startsWith(`${runId}-`)))
        .map((file) => `.paved/documents/${kind.name}/${file.name}`)
        .sort())
        .filter((path) => path !== exclude);
}
const loadEvidence = (projectRoot, run) => (run.evidence ? loadYaml(resolveSafePath(projectRoot, run.evidence)) : {});
function write(projectRoot, relative, lines) {
    const path = resolveSafePath(projectRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${lines.join("\n")}\n`);
    return relative;
}
/** The reviewer's findings, when they were written for the run as it is now; older rounds do not count. */
function recordedFindings(projectRoot, run) {
    const path = resolveSafePath(projectRoot, reviewRecordPath(run.id));
    const current = reviewedState(projectRoot, run);
    if (!current || !existsSync(path))
        return undefined;
    let record;
    // A malformed record is refused by the review gate with its own diagnostic; here it is simply not shown.
    try {
        record = loadYaml(path);
    }
    catch {
        return undefined;
    }
    const matches = Object.keys(current).every((key) => record.reviewed?.[key] === current[key]);
    return matches && Array.isArray(record.findings) ? record : undefined;
}
export function writeReviewDocument(projectRoot, run) {
    const relative = `.paved/generated/reviews/${run.id}.md`;
    const evidence = loadEvidence(projectRoot, run);
    const plan = planRef(run);
    const findings = recordedFindings(projectRoot, run);
    const lines = [
        `# Review of ${run.id}`, "",
        "Generated from the run's evidence record; the record stays the source of truth.", "",
        `- Workflow: \`${run.workflow?.id ?? "unclassified"}\``,
        `- Approved plan: ${plan ? `\`${plan}\`` : "none recorded"}`,
        `- Evidence record: ${run.evidence ? `\`${run.evidence}\`` : "none recorded"}`, "",
        "## Change", "", evidence.change?.summary ?? "No summary recorded.", "",
        "## Checks", "", ...(evidence.checks?.length ? ["| Check | Type | Status | Summary |", "|---|---|---|---|", ...evidence.checks.map((check) => `| ${check.check ?? check.id} | ${check.type ?? ""} | ${check.status ?? ""} | ${check.summary ?? ""} |`)] : ["No checks recorded."]), "",
        "## Artifacts", "", ...(evidence.artifacts?.length ? evidence.artifacts.map((artifact) => `- ${artifact.kind ?? "artifact"} \`${artifact.id ?? ""}\`${artifact.description ? ` ${artifact.description}` : ""}${artifact.source?.location ? ` (\`${artifact.source.location}\`)` : ""}`) : ["No artifacts recorded."]), "",
        "## Gaps", "", ...(evidence.gaps?.length ? evidence.gaps.map((gap) => `- ${gap.check_type ?? "check"}: ${gap.description ?? ""} Reason: ${gap.reason ?? "not stated"}${gap.risk ? ` (risk ${gap.risk})` : ""}${gap.accepted_by ? ` (accepted by ${gap.accepted_by})` : ""}`) : ["None."]), "",
        "## Rules", "", ...(evidence.rules?.length ? evidence.rules.map((rule) => `- \`${rule.id}\` (${rule.severity}): ${rule.status}`) : ["No rule results recorded."]), "",
        "## Independent review", "", ...(findings
            ? [`Reviewer: ${findings.reviewer?.agent ?? "unknown"}. Passes: ${(findings.passes ?? []).join(", ") || "none"}.`, "",
                ...(findings.findings.length ? findings.findings.map((finding) => `- **${finding.severity}** \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`: ${finding.summary}`) : ["No findings."])]
            : [`Not recorded yet. A separate reviewer reads \`${reviewBriefPath(run.id)}\` and writes \`${reviewRecordPath(run.id)}\`.`]), "",
    ];
    return write(projectRoot, relative, lines);
}
/** Everything a reviewer with its own context needs, and nothing from the conversation that wrote the change. */
export function writeReviewBrief(projectRoot, run, reviewed) {
    const evidence = loadEvidence(projectRoot, run);
    const plan = planRef(run);
    const intent = intentDocumentPath(run.id);
    const diff = evidence.artifacts?.find((artifact) => artifact.kind === "diff")?.source?.location;
    const lines = [
        `# Review brief for ${run.id}`, "",
        "You are reviewing a change you did not write. Work only from the files below, not from the",
        "conversation that produced the change, and do not edit anything except your findings file.", "",
        ...(existsSync(resolveSafePath(projectRoot, intent)) ? [`- Request: \`${intent}\``] : []),
        `- Approved plan: ${plan ? `\`${plan}\`` : "none recorded"}`,
        `- Evidence record: ${run.evidence ? `\`${run.evidence}\`` : "none recorded"}`,
        `- Diff: ${diff ? `\`${diff}\`` : "see the evidence record"}`,
        `- Rules in scope: ${evidence.rules?.length ? evidence.rules.map((rule) => `\`${rule.id}\``).join(", ") : "none recorded"}`, "",
        "Follow the change-review skill: run the rules, diff and change passes, then keep only",
        "findings you validated against the code. A blocking finding is a defect you can demonstrate;",
        "anything else is a note. Use `findings: []` when nothing survives.", "",
        `Write your findings to \`${reviewRecordPath(run.id)}\`:`, "",
        "```yaml",
        "apiVersion: paved/v1",
        "kind: ChangeReview",
        `run: ${run.id}`,
        "reviewer:",
        "  agent: <your agent and model>",
        "  isolated: true",
        "reviewed:",
        `  plan_sha256: ${reviewed.plan_sha256}`,
        `  source_sha256: ${reviewed.source_sha256}`,
        `  evidence_sha256: ${reviewed.evidence_sha256}`,
        "passes: [rules, diff, change]",
        "findings:",
        "  - severity: blocking",
        "    file: path/to/file",
        "    line: 42",
        "    summary: What is wrong, and the input or state that shows it.",
        "```", "",
    ];
    return write(projectRoot, reviewBriefPath(run.id), lines);
}
/** The document a person must review for this run's current state, if any. */
export function reviewFor(projectRoot, run) {
    if (!run.workflow && run.status === "awaiting-input")
        return reviewBlock(intentDocumentPath(run.id));
    const awaitingPlan = run.phases.some((phase) => phase.gates?.some((gate) => gate.id === "plan-approved" && gate.status === "awaiting-approval"));
    const plan = planRef(run);
    if (awaitingPlan && plan)
        return reviewBlock(plan, companionDocuments(projectRoot, run.id, plan));
    if (run.phases.some((phase) => phase.phase === "review" && phase.status === "running")) {
        const reviewed = reviewedState(projectRoot, run);
        const independent = reviewed && { brief: writeReviewBrief(projectRoot, run, reviewed), record: reviewRecordPath(run.id), reviewed };
        return reviewBlock(writeReviewDocument(projectRoot, run), [], independent);
    }
    return undefined;
}
