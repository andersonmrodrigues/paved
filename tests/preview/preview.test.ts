import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { agentWatching, digest, markWatching, previewTarget, readReview, reviewPath } from "../../cli/lib/preview-review.ts";
import { servePreview } from "../../cli/lib/preview-server.ts";
import { at, cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

after(cleanupTemporaryDirectories);

async function api(port: number, token: string, route: string, value?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: value === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "content-type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

type Result = { status: string; data: Record<string, unknown>; diagnostics?: { message: string }[] };

function cli(root: string) {
  return (...args: string[]) => JSON.parse(execFileSync(process.execPath,
    [at("cli/index.ts"), "preview", ...args, "--project", root, "--json"], { encoding: "utf8" })) as Result;
}

function epic(name: string): string {
  const root = temporaryDirectory(name);
  mkdirSync(join(root, "epic/tasks"), { recursive: true });
  mkdirSync(join(root, "epic/.drafts"));
  writeFileSync(join(root, "epic/overview.md"), "# Epic\n\nShip **exports**.\n");
  writeFileSync(join(root, "epic/tasks/01-download.md"), "# Download\n\nOne certificate as a file.\n");
  writeFileSync(join(root, "epic/tasks/notes.txt"), "not Markdown\n");
  writeFileSync(join(root, "epic/.drafts/hidden.md"), "# Hidden\n");
  return root;
}

describe("Markdown preview", () => {
  it("starts and stops the packaged CLI server without an agent-specific runtime", () => {
    const root = temporaryDirectory("preview-cli");
    writeFileSync(join(root, "spec.md"), "# Specification\n");
    const call = cli(root);
    const started = call("start", "spec.md");
    try {
      assert.equal(started.status, "success");
      assert.match(String(started.data.url), /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
      assert.equal(call("status", "spec.md").data.target, "spec.md");
    } finally { assert.equal(call("stop", "spec.md").data.stopped, true); }
  });

  it("lists the visible Markdown files of a folder in path order", () => {
    const root = epic("preview-folder-list");
    symlinkSync(join(root, "epic/overview.md"), join(root, "epic/tasks/linked.md"));
    const target = previewTarget(root, "epic");
    assert.equal(target.kind, "folder");
    assert.deepEqual(target.documents.map((entry) => entry.relative), ["epic/overview.md", "epic/tasks/01-download.md"]);
    assert.throws(() => previewTarget(root, "epic/tasks/notes.txt"), /Markdown/);
    mkdirSync(join(root, "empty"));
    assert.throws(() => previewTarget(root, "empty"), /no Markdown/);
    assert.throws(() => previewTarget(root, "../outside"), /./);
  });

  it("serves safe Markdown and takes anchored comments on any document of a folder", async () => {
    const root = epic("preview-folder");
    writeFileSync(join(root, "epic/overview.md"), "# Epic\n\nShip **exports**. <script>alert(1)</script>\n");
    const server = await servePreview(root, at("."), "epic");
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status, 403);
      const state = await (await api(server.port, server.token, "/api/state")).json() as { kind: string; documents: { path: string; sha: string }[] };
      assert.equal(state.kind, "folder");
      assert.deepEqual(state.documents.map((entry) => entry.path), ["epic/overview.md", "epic/tasks/01-download.md"]);
      const overview = await (await api(server.port, server.token, "/api/document?path=epic/overview.md")).json() as { html: string; sha: string };
      assert.match(overview.html, /<strong>exports<\/strong>/);
      assert.doesNotMatch(overview.html, /<script>/);
      assert.equal((await api(server.port, server.token, "/api/document?path=epic/.drafts/hidden.md")).status, 400);
      const task = state.documents[1]!;
      const comment = { document: task.path, quote: "certificate", prefix: "One ", suffix: " as", offset: 13, body: "Which format?" };
      assert.equal((await api(server.port, server.token, "/api/comments", { ...comment, document_sha256: overview.sha })).status, 400);
      assert.equal((await api(server.port, server.token, "/api/comments", { ...comment, document: "epic/.drafts/hidden.md", document_sha256: task.sha })).status, 400);
      assert.equal((await api(server.port, server.token, "/api/comments", { ...comment, document_sha256: task.sha })).status, 201);
      assert.equal((await api(server.port, server.token, "/api/approve", { document_sha256: task.sha })).status, 404);
      const after = await (await api(server.port, server.token, "/api/state")).json() as { documents: { unresolved: number }[] };
      assert.deepEqual(after.documents.map((entry) => entry.unresolved), [0, 1]);
      writeFileSync(join(root, "epic/tasks/02-bulk.md"), "# Bulk\n");
      const grown = await (await api(server.port, server.token, "/api/state")).json() as { documents: unknown[] };
      assert.equal(grown.documents.length, 3);
    } finally {
      await api(server.port, server.token, "/api/stop", {});
    }
  });

  it("shows the reviewer when the agent receives, works on and resolves each comment", async () => {
    const root = epic("preview-lifecycle");
    const call = cli(root);
    const server = await servePreview(root, at("."), "epic");
    try {
      const sha = digest(readFileSync(join(root, "epic/overview.md")));
      const posted = await (await api(server.port, server.token, "/api/comments", {
        document: "epic/overview.md", quote: "exports", prefix: "Ship ", suffix: ".", offset: 10, body: "Which exports?", document_sha256: sha,
      })).json() as { id: string; status: string };
      assert.equal(posted.status, "open");
      const status = () => readReview(root, at("."), previewTarget(root, "epic")).comments[0]!.status;

      const waited = call("wait", "epic", "0");
      const delivered = waited.data.comments as { id: string; document: string }[];
      assert.deepEqual(delivered.map((entry) => entry.document), ["epic/overview.md"]);
      assert.match(String(waited.data.next_action), /paved preview working epic/);
      assert.equal(status(), "received");

      assert.equal((call("working", "epic", posted.id).data.comment as { status: string }).status, "working");
      const resolved = call("resolve", "epic", posted.id, "--reply", "Listed certificate and report exports.");
      assert.equal((resolved.data.comment as { reply: string }).reply, "Listed certificate and report exports.");
      assert.equal(status(), "resolved");
      assert.match(String(resolved.data.next_action), new RegExp(`paved preview wait epic ${resolved.data.revision}`));
    } finally {
      await api(server.port, server.token, "/api/stop", {});
    }
  });

  it("tells the reviewer whether an agent is waiting for comments", async () => {
    const root = temporaryDirectory("preview-watch");
    writeFileSync(join(root, "plan.md"), "# Plan\n");
    const server = await servePreview(root, at("."), "plan.md");
    try {
      const state = async () => (await (await api(server.port, server.token, "/api/state")).json() as { watching: boolean }).watching;
      assert.equal(await state(), false);
      markWatching(root, "plan.md");
      assert.equal(await state(), true);
      assert.equal(agentWatching(root, "plan.md", Date.now() + 61_000), false);
    } finally {
      await api(server.port, server.token, "/api/stop", {});
    }
  });

  it("reads a review written before folders existed and drops its approval", () => {
    const root = temporaryDirectory("preview-legacy");
    writeFileSync(join(root, "plan.md"), "# Plan\n");
    const path = reviewPath(root, "plan.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ apiVersion: "paved/v1", kind: "PreviewReview", document: "plan.md", revision: 2, run: "feature-123",
      approval: { document_sha256: "0".repeat(64), decided_by: "someone", decided_at: "2026-09-29T10:00:00.000Z" },
      comments: [{ id: "98f4869a-8b87-4a6b-bd79-a0853cef709b", quote: "Plan", prefix: "", suffix: "", offset: 0, body: "Rename.",
        status: "open", created_at: "2026-09-29T10:00:00.000Z", document_sha256: "0".repeat(64) }] }));
    const review = readReview(root, at("."), previewTarget(root, "plan.md"));
    assert.equal(review.target, "plan.md");
    assert.equal(review.comments[0]!.document, "plan.md");
    assert.equal("approval" in review, false);
  });
});
