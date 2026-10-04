import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { intentDocumentPath } from "./intent.ts";
import { resolveSafePath } from "./safe-path.ts";
import type { Run } from "./workflow-runs.ts";

export interface ReviewBlock { readonly target: string; readonly preview: string; readonly companions: readonly string[] }

export function reviewBlock(target: string, companions: readonly string[] = []): ReviewBlock {
  return { target, preview: `paved preview start ${target} --json`, companions };
}

/** Markdown documents of the same run under .paved/documents/, other than `exclude`. */
export function companionDocuments(projectRoot: string, runId: string, exclude: string): string[] {
  const root = join(projectRoot, ".paved/documents");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((kind) => kind.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((kind) => readdirSync(join(root, kind.name), { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".md") && (file.name === `${runId}.md` || file.name.startsWith(`${runId}-`)))
      .map((file) => `.paved/documents/${kind.name}/${file.name}`)
      .sort())
    .filter((path) => path !== exclude);
}

interface EvidenceView {
  change?: { summary?: string };
  checks?: { id?: string; check?: string; type?: string; status?: string; summary?: string }[];
  artifacts?: { id?: string; kind?: string; description?: string; source?: { location?: string } }[];
  gaps?: { check_type?: string; description?: string; reason?: string; risk?: string; accepted_by?: string }[];
  rules?: { id?: string; severity?: string; status?: string }[];
}

const planRef = (run: Run) => run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;

export function writeReviewDocument(projectRoot: string, run: Run): string {
  const relative = `.paved/generated/reviews/${run.id}.md`;
  const evidence = (run.evidence ? loadYaml(resolveSafePath(projectRoot, run.evidence)) : {}) as EvidenceView;
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
export function reviewFor(projectRoot: string, run: Run): ReviewBlock | undefined {
  if (!run.workflow && run.status === "awaiting-input") return reviewBlock(intentDocumentPath(run.id));
  const awaitingPlan = run.phases.some((phase) => phase.gates?.some((gate) => gate.id === "plan-approved" && gate.status === "awaiting-approval"));
  const plan = planRef(run);
  if (awaitingPlan && plan) return reviewBlock(plan, companionDocuments(projectRoot, run.id, plan));
  if (run.phases.some((phase) => phase.phase === "review" && phase.status === "running")) return reviewBlock(writeReviewDocument(projectRoot, run));
  return undefined;
}
