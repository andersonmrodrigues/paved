import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";

export interface PreviewComment {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  offset: number;
  body: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at?: string;
  document_sha256: string;
}

export interface PreviewReview {
  apiVersion: "paved/v1";
  kind: "PreviewReview";
  document: string;
  revision: number;
  run?: string;
  approval?: { document_sha256: string; decided_by: string; decided_at: string };
  comments: PreviewComment[];
}

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function previewDocument(root: string, name: string): { path: string; relative: string } {
  if (!/\.md$/i.test(name)) throw new Error("Preview requires a Markdown (.md) file.");
  const path = resolveSafePath(root, name);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Markdown file does not exist: ${name}`);
  return { path, relative: relative(realpathSync(root), path).split(sep).join("/") };
}

export function reviewPath(root: string, document: string): string {
  return resolveSafePath(root, `.paved/generated/previews/${digest(document)}.json`);
}

export function readReview(root: string, coreRoot: string, document: string): PreviewReview {
  const path = reviewPath(root, document);
  const review: PreviewReview = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as PreviewReview
    : { apiVersion: "paved/v1", kind: "PreviewReview", document, revision: 0, comments: [] };
  const checked = createRegistry(`${coreRoot}/schemas`, ["paved/v1"]).validate(review);
  if (!checked.valid || review.document !== document) throw new Error(`Invalid preview review: ${checked.errors.join("; ")}`);
  return review;
}

export function writeReview(root: string, coreRoot: string, review: PreviewReview): void {
  const checked = createRegistry(`${coreRoot}/schemas`, ["paved/v1"]).validate(review);
  if (!checked.valid) throw new Error(`Invalid preview review: ${checked.errors.join("; ")}`);
  const path = reviewPath(root, review.document);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(review, null, 2)}\n`);
}

export function addComment(review: PreviewReview, documentSha: string, value: Record<string, unknown>): PreviewComment {
  if (review.approval?.document_sha256 === documentSha) throw new Error("This version is already approved.");
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const quote = typeof value.quote === "string" ? value.quote.trim() : "";
  const prefix = typeof value.prefix === "string" ? value.prefix : "";
  const suffix = typeof value.suffix === "string" ? value.suffix : "";
  const offset = value.offset;
  if (!body || body.length > 10000 || !quote || quote.length > 4000 || prefix.length > 80 || suffix.length > 80
    || !Number.isSafeInteger(offset) || (offset as number) < 0 || value.document_sha256 !== documentSha) {
    throw new Error("Invalid or stale comment selection.");
  }
  const comment: PreviewComment = { id: randomUUID(), quote, prefix, suffix, offset: offset as number, body,
    status: "open", created_at: new Date().toISOString(), document_sha256: documentSha };
  review.comments.push(comment);
  review.revision += 1;
  return comment;
}

export function resolveComment(review: PreviewReview, id: string): PreviewComment {
  const comment = review.comments.find((entry) => entry.id === id);
  if (!comment) throw new Error("Comment does not exist.");
  if (comment.status === "open") {
    comment.status = "resolved";
    comment.resolved_at = new Date().toISOString();
    review.revision += 1;
  }
  return comment;
}

export function bindWorkflowApproval(root: string, review: PreviewReview, documentSha: string): void {
  if (!review.run) return;
  const runPath = resolveSafePath(root, `.paved/generated/runs/${review.run}.yaml`);
  if (!existsSync(runPath)) throw new Error("Workflow run does not exist.");
  const run = loadYaml(runPath) as { events?: { type?: string; phase?: string; ref?: string }[];
    phases?: { phase?: string; gates?: { id?: string; status?: string; reason?: string }[] }[] };
  const request = run.events?.findLast((event) => event.type === "approval-requested" && event.phase === "planning");
  const gate = run.phases?.find((phase) => phase.phase === "planning")?.gates?.find((item) => item.id === "plan-approved");
  if (request?.ref !== review.document || gate?.status !== "awaiting-approval" || gate.reason !== `plan_sha256=${documentSha}`) {
    throw new Error("Workflow approval request does not match this version of the plan.");
  }
}

export function approveReview(root: string, coreRoot: string, review: PreviewReview, documentSha: string, name: string): void {
  const decidedBy = name.trim();
  if (!decidedBy || decidedBy.length > 120 || ["agent", "paved", "ci"].includes(decidedBy.toLowerCase())) {
    throw new Error("Enter the name of the person approving the document.");
  }
  if (review.comments.some((comment) => comment.status === "open")) throw new Error("Resolve open comments before approval.");
  bindWorkflowApproval(root, review, documentSha);
  const decidedAt = new Date().toISOString();
  review.approval = { document_sha256: documentSha, decided_by: decidedBy, decided_at: decidedAt };
  review.revision += 1;
  writeReview(root, coreRoot, review);
  if (review.run) {
    const path = resolveSafePath(root, `.paved/approvals/${review.run}.json`);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify({ run: review.run, plan_sha256: documentSha, decision: "approved",
      decided_by: decidedBy, decided_at: decidedAt }, null, 2)}\n`);
  }
}
