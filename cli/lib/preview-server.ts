import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { addComment, approveReview, digest, previewDocument, readReview, reviewPath, writeReview } from "./preview-review.ts";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

export interface PreviewServerInfo { pid: number; port: number; token: string; document: string; run?: string }

export function serverInfoPath(root: string, document: string): string {
  return `${reviewPath(root, document)}.server.json`;
}

function json(response: ServerResponse, code: number, value: unknown): void {
  response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function error(response: ServerResponse, code: number, message: string): void { json(response, code, { error: message }); }

function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32768) { reject(new Error("Request is too large.")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
        resolve(value as Record<string, unknown>);
      } catch (cause) { reject(cause); }
    });
    request.on("error", reject);
  });
}

function htmlDocument(coreRoot: string): string { return readFileSync(join(coreRoot, "cli/assets/preview.html"), "utf8"); }

export async function servePreview(root: string, coreRoot: string, file: string, run?: string): Promise<PreviewServerInfo> {
  const document = previewDocument(root, file);
  const review = readReview(root, coreRoot, document.relative);
  if (run && review.run && review.run !== run) throw new Error("This document is already linked to another workflow run.");
  if (run && !review.run) { review.run = run; writeReview(root, coreRoot, review); }
  const token = randomBytes(24).toString("hex");
  const html = htmlDocument(coreRoot);
  const infoPath = serverInfoPath(root, document.relative);
  let serverPort = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${serverPort}`);
      const cookieName = `paved_preview_${serverPort}`;
      const authorized = request.headers.authorization === `Bearer ${token}` ||
        request.headers.cookie?.split(/;\s*/).includes(`${cookieName}=${token}`);
      if (url.pathname === "/" && request.method === "GET") {
        if (url.searchParams.get("token") !== token && !authorized) return error(response, 403, "Invalid preview token.");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "set-cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` });
        response.end(html);
        return;
      }
      if ((url.pathname === "/preview.css" || url.pathname === "/preview.js") && request.method === "GET") {
        if (!authorized) return error(response, 403, "Invalid preview token.");
        const asset = url.pathname === "/preview.css" ? "preview.css" : "preview.js";
        response.writeHead(200, { "content-type": asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(readFileSync(join(coreRoot, "cli/assets", asset)));
        return;
      }
      if (!authorized) return error(response, 403, "Invalid preview token.");
      if (request.method === "POST" && request.headers.origin !== `http://127.0.0.1:${serverPort}`
        && request.headers.authorization !== `Bearer ${token}`) return error(response, 403, "Invalid origin.");
      if (url.pathname === "/api/state" && request.method === "GET") {
        const source = readFileSync(document.path, "utf8");
        const current = readReview(root, coreRoot, document.relative);
        const sha = digest(source);
        return json(response, 200, { document: document.relative, sha, html: markdown.render(source), review: current,
          approved: current.approval?.document_sha256 === sha });
      }
      if (url.pathname === "/api/comments" && request.method === "POST") {
        const value = await body(request);
        const current = readReview(root, coreRoot, document.relative);
        const comment = addComment(current, digest(readFileSync(document.path)), value);
        writeReview(root, coreRoot, current);
        return json(response, 201, comment);
      }
      if (url.pathname === "/api/approve" && request.method === "POST") {
        const value = await body(request);
        const current = readReview(root, coreRoot, document.relative);
        const sha = digest(readFileSync(document.path));
        if (value.document_sha256 !== sha) return error(response, 409, "The document changed. Review the latest version before approving.");
        approveReview(root, coreRoot, current, sha, typeof value.decided_by === "string" ? value.decided_by : "");
        return json(response, 200, { approved: true });
      }
      if (url.pathname === "/api/stop" && request.method === "POST" && request.headers.authorization === `Bearer ${token}`) {
        json(response, 200, { stopped: true });
        server.close();
        return;
      }
      error(response, 404, "Unknown preview endpoint.");
    } catch (cause) {
      error(response, 400, cause instanceof Error ? cause.message : "Preview request failed.");
    }
  });
  server.on("close", () => { if (existsSync(infoPath)) rmSync(infoPath); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server has no port.");
  serverPort = address.port;
  const info: PreviewServerInfo = { pid: process.pid, port: serverPort, token, document: document.relative, ...(run ? { run } : {}) };
  mkdirSync(dirname(infoPath), { recursive: true });
  atomicWriteFileSync(infoPath, `${JSON.stringify(info)}\n`);
  return info;
}
