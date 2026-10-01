import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDiagnostic, createResult } from "../result.js";
import { markReceived, markWatching, markWorking, previewTarget, readReview, resolveComment, unresolved, writeReview } from "../lib/preview-review.js";
import { servePreview, serverInfoPath } from "../lib/preview-server.js";
const USAGE = "Use paved preview start|serve|status|wait|working|resolve|stop <file.md|folder>.";
function failure(message) {
    return createResult({ command: "preview", status: "failed", diagnostics: [createDiagnostic({
                severity: "error", category: "usage", code: "PAVED_PREVIEW_ERROR", component: "cli.commands.preview", message,
            })] });
}
function info(root, target) {
    const path = serverInfoPath(root, target);
    if (!existsSync(path))
        return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
}
async function alive(value) {
    try {
        const response = await fetch(`http://127.0.0.1:${value.port}/api/state`, {
            headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
function details(value) {
    return { url: `http://127.0.0.1:${value.port}/?token=${value.token}`, port: value.port, target: value.target };
}
export async function previewHandler(invocation) {
    const [operation, name, argument] = invocation.selectors;
    const { projectRoot: root, coreRoot } = invocation.paths;
    if (!operation || !name)
        return failure(USAGE);
    try {
        const target = previewTarget(root, name);
        const waitAgain = (revision) => `paved preview wait ${target.relative} ${revision} --json`;
        if (operation === "serve") {
            const value = await servePreview(root, coreRoot, name);
            return createResult({ command: "preview", status: "success", data: details(value) });
        }
        if (operation === "start") {
            const existing = info(root, target.relative);
            if (existing && await alive(existing))
                return createResult({ command: "preview", status: "success", data: details(existing) });
            const path = serverInfoPath(root, target.relative);
            if (existsSync(path))
                rmSync(path);
            const args = [resolve(process.cwd(), process.argv[1]), "preview", "serve", target.relative, "--project", root, "--json"];
            const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore" });
            child.unref();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                await delay(100);
                const value = info(root, target.relative);
                if (value && await alive(value))
                    return createResult({ command: "preview", status: "success", data: details(value) });
            }
            return failure("Preview server did not start. Run paved preview serve <file.md|folder> to inspect the error.");
        }
        if (operation === "status") {
            const review = readReview(root, coreRoot, target);
            const value = info(root, target.relative);
            return createResult({ command: "preview", status: "success", data: {
                    target: target.relative, kind: target.kind, documents: target.documents.map((entry) => entry.relative),
                    revision: review.revision, comments: review.comments, ...(value && await alive(value) ? details(value) : {}),
                } });
        }
        if (operation === "wait") {
            const since = argument === undefined ? -1 : Number(argument);
            if (!Number.isSafeInteger(since) || since < -1)
                return failure("Wait cursor must be a nonnegative revision.");
            for (let attempt = 0; attempt < 60; attempt += 1) {
                markWatching(root, target.relative);
                const review = readReview(root, coreRoot, target);
                if (review.revision > since) {
                    // Handing comments to the agent is what the reviewer sees as "received".
                    if (markReceived(review))
                        writeReview(root, coreRoot, review);
                    const pending = unresolved(review);
                    const nextAction = pending.length > 0
                        ? `For each comment: run paved preview working ${target.relative} <comment-id> --json, apply it to its document, then run paved preview resolve ${target.relative} <comment-id> --reply "<what changed>" --json. Then call ${waitAgain(review.revision)} with the revision returned by your last command, without ending the turn.`
                        : `Call ${waitAgain(review.revision)} without ending the turn. Stop only when the user says in the conversation that the review is finished.`;
                    return createResult({ command: "preview", status: "success", data: { revision: review.revision,
                            comments: pending, next_action: nextAction } });
                }
                await delay(500);
            }
            return createResult({ command: "preview", status: "success", data: { revision: since, timeout: true,
                    next_action: `No reviewer activity yet. Call ${waitAgain(since)} again now; a timeout is not a reason to end the turn. Stop only when the user says in the conversation that the review is finished.` } });
        }
        if (operation === "working" || operation === "resolve") {
            if (!argument)
                return failure("Supply the comment id.");
            const review = readReview(root, coreRoot, target);
            const comment = operation === "working" ? markWorking(review, argument) : resolveComment(review, argument, invocation.flags.reply);
            writeReview(root, coreRoot, review);
            return createResult({ command: "preview", status: "success", data: { comment, revision: review.revision,
                    next_action: operation === "working"
                        ? `Apply the comment to ${comment.document}, then resolve it with --reply.`
                        : `Continue with the next comment, or call ${waitAgain(review.revision)}.` } });
        }
        if (operation === "stop") {
            const value = info(root, target.relative);
            if (value && await alive(value))
                await fetch(`http://127.0.0.1:${value.port}/api/stop`, {
                    method: "POST", headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(1000),
                });
            return createResult({ command: "preview", status: "success", data: { stopped: true } });
        }
        return failure(`Unknown preview operation: ${operation}. ${USAGE}`);
    }
    catch (cause) {
        return failure(cause instanceof Error ? cause.message : "Preview failed.");
    }
}
