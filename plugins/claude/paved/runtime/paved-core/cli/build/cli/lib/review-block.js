import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadYaml } from "./documents.js";
import { intentDocumentPath } from "./intent.js";
import { resolveSafePath } from "./safe-path.js";
export function reviewBlock(target, companions = []) {
    return { target, preview: `paved preview start ${target} --json`, companions };
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
const planRef = (run) => run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
export function writeReviewDocument(projectRoot, run) {
    const relative = `.paved/generated/reviews/${run.id}.md`;
    const evidence = (run.evidence ? loadYaml(resolveSafePath(projectRoot, run.evidence)) : {});
    const plan = planRef(run);
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
    ];
    const path = resolveSafePath(projectRoot, relative);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${lines.join("\n")}\n`);
    return relative;
}
/** The document a person must review for this run's current state, if any. */
export function reviewFor(projectRoot, run) {
    if (!run.workflow && run.status === "awaiting-input")
        return reviewBlock(intentDocumentPath(run.id));
    const awaitingPlan = run.phases.some((phase) => phase.gates?.some((gate) => gate.id === "plan-approved" && gate.status === "awaiting-approval"));
    const plan = planRef(run);
    if (awaitingPlan && plan)
        return reviewBlock(plan, companionDocuments(projectRoot, run.id, plan));
    if (run.phases.some((phase) => phase.phase === "review" && phase.status === "running"))
        return reviewBlock(writeReviewDocument(projectRoot, run));
    return undefined;
}
