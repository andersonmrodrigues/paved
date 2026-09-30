import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { digest, markWatching, previewDocument, readReview, resolveComment, writeReview } from "../lib/preview-review.ts";
import { servePreview, serverInfoPath, type PreviewServerInfo } from "../lib/preview-server.ts";

function failure(message: string): CommandResult {
  return createResult({ command: "preview", status: "failed", diagnostics: [createDiagnostic({
    severity: "error", category: "usage", code: "PAVED_PREVIEW_ERROR", component: "cli.commands.preview", message,
  })] });
}

function info(root: string, document: string): PreviewServerInfo | undefined {
  const path = serverInfoPath(root, document);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as PreviewServerInfo;
}

async function alive(value: PreviewServerInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}/api/state`, {
      headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch { return false; }
}

function details(value: PreviewServerInfo): { url: string; port: number; document: string; run?: string } {
  return { url: `http://127.0.0.1:${value.port}/?token=${value.token}`, port: value.port,
    document: value.document, ...(value.run ? { run: value.run } : {}) };
}

export async function previewHandler(invocation: CommandInvocation): Promise<CommandResult> {
  const [operation, name, argument] = invocation.selectors;
  const { projectRoot: root, coreRoot } = invocation.paths;
  if (!operation || !name) return failure("Use paved preview start|serve|status|wait|resolve|stop <file.md>.");
  try {
    const document = previewDocument(root, name);
    if (operation === "serve") {
      const value = await servePreview(root, coreRoot, name, invocation.flags.run);
      return createResult({ command: "preview", status: "success", data: details(value) });
    }
    if (operation === "start") {
      const existing = info(root, document.relative);
      if (existing && await alive(existing)) {
        if (invocation.flags.run && existing.run !== invocation.flags.run) return failure("Preview is already running for a different workflow run.");
        return createResult({ command: "preview", status: "success", data: details(existing) });
      }
      const path = serverInfoPath(root, document.relative);
      if (existsSync(path)) rmSync(path);
      const args = [resolve(process.cwd(), process.argv[1]!), "preview", "serve", document.relative, "--project", root, "--json"];
      if (invocation.flags.run) args.push("--run", invocation.flags.run);
      const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore" });
      child.unref();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(100);
        const value = info(root, document.relative);
        if (value && await alive(value)) return createResult({ command: "preview", status: "success", data: details(value) });
      }
      return failure("Preview server did not start. Run paved preview serve <file.md> to inspect the error.");
    }
    if (operation === "status") {
      const review = readReview(root, coreRoot, document.relative);
      const sha = digest(readFileSync(document.path));
      const value = info(root, document.relative);
      return createResult({ command: "preview", status: "success", data: {
        document: document.relative, sha, revision: review.revision, run: review.run,
        approved: review.approval?.document_sha256 === sha,
        comments: review.comments, ...(value && await alive(value) ? details(value) : {}),
      } });
    }
    if (operation === "wait") {
      const since = argument === undefined ? -1 : Number(argument);
      if (!Number.isSafeInteger(since) || since < -1) return failure("Wait cursor must be a nonnegative revision.");
      const waitAgain = (revision: number) => `paved preview wait ${document.relative} ${revision} --json`;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        markWatching(root, document.relative);
        const review = readReview(root, coreRoot, document.relative);
        if (review.revision > since) {
          const sha = digest(readFileSync(document.path));
          const approved = review.approval?.document_sha256 === sha;
          const open = review.comments.filter((comment) => comment.status === "open");
          const nextAction = approved
            ? (review.run ? `The reviewer approved this version. Resume the workflow with --run ${review.run} --advance.` : "The reviewer approved this version.")
            : open.length > 0
              ? `Apply each open comment to ${document.relative}, resolve it with paved preview resolve, then call ${waitAgain(review.revision)} without ending the turn.`
              : `Call ${waitAgain(review.revision)} without ending the turn.`;
          return createResult({ command: "preview", status: "success", data: { revision: review.revision, approved,
            comments: open, next_action: nextAction } });
        }
        await delay(500);
      }
      return createResult({ command: "preview", status: "success", data: { revision: since, timeout: true,
        next_action: `No reviewer activity yet. Call ${waitAgain(since)} again now; a timeout is not a reason to end the turn while the review is not approved.` } });
    }
    if (operation === "resolve") {
      if (!argument) return failure("Supply the comment id to resolve.");
      const review = readReview(root, coreRoot, document.relative);
      const comment = resolveComment(review, argument);
      writeReview(root, coreRoot, review);
      return createResult({ command: "preview", status: "success", data: { comment, revision: review.revision } });
    }
    if (operation === "stop") {
      const value = info(root, document.relative);
      if (value && await alive(value)) await fetch(`http://127.0.0.1:${value.port}/api/stop`, {
        method: "POST", headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000),
      });
      return createResult({ command: "preview", status: "success", data: { stopped: true } });
    }
    return failure(`Unknown preview operation: ${operation}.`);
  } catch (cause) { return failure(cause instanceof Error ? cause.message : "Preview failed."); }
}
