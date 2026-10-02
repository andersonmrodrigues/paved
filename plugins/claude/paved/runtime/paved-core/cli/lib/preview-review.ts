import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";

export type CommentStatus = "open" | "received" | "working" | "resolved";

export interface PreviewComment {
  id: string;
  document: string;
  quote: string;
  prefix: string;
  suffix: string;
  offset: number;
  body: string;
  status: CommentStatus;
  created_at: string;
  received_at?: string;
  working_at?: string;
  resolved_at?: string;
  reply?: string;
  document_sha256: string;
}

export interface PreviewReview {
  apiVersion: "paved/v1";
  kind: "PreviewReview";
  target: string;
  target_kind: "file" | "folder";
  revision: number;
  comments: PreviewComment[];
}

export interface PreviewDocument { path: string; relative: string }

export interface PreviewTarget {
  kind: "file" | "folder";
  path: string;
  relative: string;
  documents: PreviewDocument[];
}

export const MAX_FOLDER_DOCUMENTS = 200;

export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const projectRelative = (root: string, path: string): string =>
  relative(realpathSync(root), path).split(sep).join("/") || ".";

// Hidden directories hold tool state and dependencies, never documents under review.
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

function folderDocuments(root: string, folder: string): PreviewDocument[] {
  const found: PreviewDocument[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      // Links could point outside the project, so only real files and directories are followed.
      if (lstatSync(path).isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        found.push({ path, relative: projectRelative(root, path) });
        if (found.length > MAX_FOLDER_DOCUMENTS) {
          throw new Error(`The folder has more than ${MAX_FOLDER_DOCUMENTS} Markdown files; preview a narrower folder.`);
        }
      }
    }
  };
  visit(folder);
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}

export function previewTarget(root: string, name: string): PreviewTarget {
  const path = resolveSafePath(root, name);
  if (!existsSync(path)) throw new Error(`Preview target does not exist: ${name}`);
  const relativePath = projectRelative(root, path);
  if (statSync(path).isDirectory()) {
    const documents = folderDocuments(root, path);
    if (documents.length === 0) throw new Error(`The folder has no Markdown (.md) files: ${name}`);
    return { kind: "folder", path, relative: relativePath, documents };
  }
  if (!/\.md$/i.test(name)) throw new Error("Preview requires a Markdown (.md) file or a folder.");
  return { kind: "file", path, relative: relativePath, documents: [{ path, relative: relativePath }] };
}

export function reviewPath(root: string, target: string): string {
  return resolveSafePath(root, `.paved/generated/previews/${digest(target)}.json`);
}

// An agent editing documents between two waits can be silent for a while, so the window is generous.
const WATCH_WINDOW_MS = 60_000;

function watchPath(root: string, target: string): string {
  return `${reviewPath(root, target)}.watch.json`;
}

export function markWatching(root: string, target: string): void {
  const path = watchPath(root, target);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
}

export function agentWatching(root: string, target: string, now = Date.now()): boolean {
  const path = watchPath(root, target);
  if (!existsSync(path)) return false;
  try {
    const at = Date.parse((JSON.parse(readFileSync(path, "utf8")) as { at?: string }).at ?? "");
    return now - at <= WATCH_WINDOW_MS;
  } catch { return false; }
}

// Reviews written before folders existed named a single document and could carry an approval.
function upgradeLegacy(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof value.document !== "string" || "target" in value) return value;
  const { document, run: _run, approval: _approval, ...rest } = value;
  const comments = Array.isArray(rest.comments) ? rest.comments as Record<string, unknown>[] : [];
  return { ...rest, target: document, target_kind: "file", comments: comments.map((comment) => ({ ...comment, document })) };
}

function validate(coreRoot: string, review: PreviewReview): void {
  const checked = createRegistry(`${coreRoot}/schemas`, ["paved/v1"]).validate(review);
  if (!checked.valid) throw new Error(`Invalid preview review: ${checked.errors.join("; ")}`);
}

export function readReview(root: string, coreRoot: string, target: PreviewTarget): PreviewReview {
  const path = reviewPath(root, target.relative);
  const review = existsSync(path)
    ? upgradeLegacy(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) as unknown as PreviewReview
    : { apiVersion: "paved/v1", kind: "PreviewReview", target: target.relative, target_kind: target.kind, revision: 0, comments: [] } as PreviewReview;
  validate(coreRoot, review);
  if (review.target !== target.relative) throw new Error("Invalid preview review: it belongs to another target.");
  return review;
}

export function writeReview(root: string, coreRoot: string, review: PreviewReview): void {
  validate(coreRoot, review);
  const path = reviewPath(root, review.target);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(review, null, 2)}\n`);
}

export function targetDocument(target: PreviewTarget, name: unknown): PreviewDocument {
  const document = target.documents.find((entry) => entry.relative === name);
  if (!document) throw new Error("The document is not part of this preview.");
  return document;
}

export function addComment(review: PreviewReview, target: PreviewTarget, value: Record<string, unknown>): PreviewComment {
  const document = targetDocument(target, value.document);
  const documentSha = digest(readFileSync(document.path));
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const quote = typeof value.quote === "string" ? value.quote.trim() : "";
  const prefix = typeof value.prefix === "string" ? value.prefix : "";
  const suffix = typeof value.suffix === "string" ? value.suffix : "";
  const offset = value.offset;
  if (!body || body.length > 10000 || !quote || quote.length > 4000 || prefix.length > 80 || suffix.length > 80
    || !Number.isSafeInteger(offset) || (offset as number) < 0 || value.document_sha256 !== documentSha) {
    throw new Error("Invalid or stale comment selection.");
  }
  const comment: PreviewComment = { id: randomUUID(), document: document.relative, quote, prefix, suffix,
    offset: offset as number, body, status: "open", created_at: new Date().toISOString(), document_sha256: documentSha };
  review.comments.push(comment);
  review.revision += 1;
  return comment;
}

export const unresolved = (review: PreviewReview): PreviewComment[] =>
  review.comments.filter((comment) => comment.status !== "resolved");

/** Marks comments the agent has just been handed; returns whether anything changed. */
export function markReceived(review: PreviewReview): boolean {
  const fresh = review.comments.filter((comment) => comment.status === "open");
  const at = new Date().toISOString();
  for (const comment of fresh) { comment.status = "received"; comment.received_at = at; }
  if (fresh.length > 0) review.revision += 1;
  return fresh.length > 0;
}

function findComment(review: PreviewReview, id: string): PreviewComment {
  const comment = review.comments.find((entry) => entry.id === id);
  if (!comment) throw new Error("Comment does not exist.");
  return comment;
}

export function markWorking(review: PreviewReview, id: string): PreviewComment {
  const comment = findComment(review, id);
  if (comment.status === "resolved") throw new Error("Comment is already resolved.");
  if (comment.status !== "working") {
    comment.received_at ??= new Date().toISOString();
    comment.status = "working";
    comment.working_at = new Date().toISOString();
    review.revision += 1;
  }
  return comment;
}

export function resolveComment(review: PreviewReview, id: string, reply?: string): PreviewComment {
  const comment = findComment(review, id);
  const text = reply?.trim();
  if (text !== undefined && (text.length === 0 || text.length > 4000)) throw new Error("A reply must have between 1 and 4000 characters.");
  if (comment.status !== "resolved") {
    comment.status = "resolved";
    comment.resolved_at = new Date().toISOString();
    if (text) comment.reply = text;
    review.revision += 1;
  }
  return comment;
}
