import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadYaml } from "./documents.js";
import { intentDocumentPath } from "./intent.js";
import { resolveSafePath } from "./safe-path.js";
import { findingLocation, planRef, requiredReviewLenses, reviewBriefPath, reviewedState, reviewRecordCommand, reviewRecordPath, } from "./workflow-gates/review.js";
import { loadContract } from "./workflow-runs.js";
import { phaseContext } from "./workflows.js";
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
    const reviewed = record.reviewed;
    const matches = Object.keys(current).every((key) => reviewed?.[key] === current[key]);
    return matches && (record.kind === "ChangeReviewBundle" ? Array.isArray(record.reviews)
        : record.kind === "ChangeReview" && Array.isArray(record.findings))
        ? record : undefined;
}
function findingLine(finding) {
    const proof = finding.proof;
    const shown = proof ? ` (${proof.level}${proof.command ? `: \`${proof.command}\`` : ""})` : "";
    return `- **${finding.severity}** \`${findingLocation(finding)}\`${shown}: ${finding.summary}${proof?.expected ? ` Expected: ${proof.expected}` : ""}`;
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
            ? (() => {
                const entries = findings.kind === "ChangeReviewBundle"
                    ? findings.reviews
                    : [{ reviewer: findings.reviewer, passes: findings.passes, findings: findings.findings }];
                const allFindings = entries.flatMap((entry) => entry.findings);
                return [
                    `Reviewers: ${entries.map((entry) => `${entry.reviewer.agent} (${("lens" in entry.reviewer && entry.reviewer.lens) || "Skeptic"})`).join(", ")}.`,
                    `Passes: ${[...new Set(entries.flatMap((entry) => entry.passes))].join(", ") || "none"}.`, "",
                    ...(allFindings.length ? allFindings.map(findingLine) : ["No findings."]),
                ];
            })()
            : [`Not recorded yet. Independent reviewers read \`${reviewBriefPath(run.id)}\` and their evidence is combined in \`${reviewRecordPath(run.id)}\`.`]), "",
    ];
    return write(projectRoot, relative, lines);
}
function activeReviewPhase(coreRoot, run) {
    if (run.workflow === undefined)
        return {};
    const workflow = loadContract(coreRoot, run.workflow.id);
    const phase = workflow.phases.find((item) => item.phase === "review" && run.phases.some((active) => active.phase === item.phase && active.status === "running"));
    return { workflow, ...(phase === undefined ? {} : { phase }) };
}
/** Everything a reviewer with its own context needs, and nothing from the conversation that wrote the change. */
export function writeReviewBrief(projectRoot, run, reviewed, coreRoot, resolved = activeReviewPhase(coreRoot, run)) {
    const evidence = loadEvidence(projectRoot, run);
    const plan = planRef(run);
    const intent = intentDocumentPath(run.id);
    const { workflow, phase } = resolved;
    const diff = evidence.artifacts?.find((artifact) => artifact.kind === "diff")?.source?.location;
    const lenses = requiredReviewLenses(projectRoot, coreRoot, run);
    const lines = [
        `# Review brief for ${run.id}`, "",
        "You are reviewing a change you did not write. Work only from the files below, not from the",
        "conversation that produced the change. Review only the lens assigned to you.", "",
        ...(existsSync(resolveSafePath(projectRoot, intent)) ? [`- Request: \`${intent}\``] : []),
        `- Approved plan: ${plan ? `\`${plan}\`` : "none recorded"}`,
        `- Evidence record: ${run.evidence ? `\`${run.evidence}\`` : "none recorded"}`,
        `- Diff: ${diff ? `\`${diff}\`` : "see the evidence record"}`,
        `- Rules in scope: ${evidence.rules?.length ? evidence.rules.map((rule) => `\`${rule.id}\``).join(", ") : "none recorded"}`, "",
        `- Required independent lenses: ${lenses.join(", ") || "none; proof and verification are sufficient"}`, "",
        ...(workflow && phase ? ["## Active review phase context", "", "Apply these composed skills, Tool requirements, fragment instructions and phase policies.",
            "Tool policies never grant host permission; the host enforces its own permissions independently.", "", "```json", JSON.stringify(phaseContext(workflow, phase), null, 2), "```", ""] : []),
        "Follow the change-review skill: run the rules, diff and change passes, then keep only",
        "findings you validated against the code. Take each one as far down the proof ladder as is cheap:",
        "asserted, cited (file:line or library source), reasoned (the failure walked step by step),",
        "executed (a command running the real code shows it) or reproduced (shown in the running system).",
        "Only an executed or reproduced finding may be blocking, with the command you ran and the SHA-256",
        "of its captured output; Paved refuses a blocking finding with weaker proof. Record the rest as",
        "notes. Merge findings that share a root cause. Use `findings: []` when nothing survives.",
        "When a blocking finding breaks an in-scope rule, name it in `rule`.", "",
        "Run one isolated reviewer per required lens; each sees only this brief and records only its own findings.",
        `Combine their results in \`${reviewRecordPath(run.id)}\` using this bundle:`, "",
        "```yaml",
        "apiVersion: paved/v1",
        "kind: ChangeReviewBundle",
        `run: ${run.id}`,
        "reviewed:",
        `  plan_sha256: ${reviewed.plan_sha256}`,
        `  source_sha256: ${reviewed.source_sha256}`,
        `  evidence_sha256: ${reviewed.evidence_sha256}`,
        "reviews:",
        ...lenses.flatMap((lens) => [
            `  - reviewer: { agent: <distinct agent and model>, isolated: true, lens: ${lens} }`,
            "    passes: [rules, diff, change]",
            "    findings: []",
        ]),
        "```", "",
    ];
    return write(projectRoot, reviewBriefPath(run.id), lines);
}
/** The document a person must review for this run's current state, if any. */
export function reviewFor(projectRoot, run, coreRoot) {
    if (!run.workflow && run.status === "awaiting-input")
        return reviewBlock(intentDocumentPath(run.id));
    const awaitingPlan = run.phases.some((phase) => phase.gates?.some((gate) => gate.id === "plan-approved" && gate.status === "awaiting-approval"));
    const plan = planRef(run);
    if (awaitingPlan && plan)
        return reviewBlock(plan, companionDocuments(projectRoot, run.id, plan));
    if (run.phases.some((phase) => phase.phase === "review" && phase.status === "running")) {
        const reviewed = reviewedState(projectRoot, run);
        const requiredLenses = requiredReviewLenses(projectRoot, coreRoot, run);
        const resolved = activeReviewPhase(coreRoot, run);
        const routing = resolved.phase?.routing;
        const independent = reviewed && requiredLenses.length > 0 ? {
            brief: writeReviewBrief(projectRoot, run, reviewed, coreRoot, resolved), record: reviewRecordPath(run.id), reviewed,
            requiredLenses,
            command: reviewRecordCommand(run.id), ...(routing === undefined ? {} : { routing }),
        } : undefined;
        return reviewBlock(writeReviewDocument(projectRoot, run), [], independent);
    }
    return undefined;
}
