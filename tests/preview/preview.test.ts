import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { digest, readReview, resolveComment, writeReview } from "../../cli/lib/preview-review.ts";
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

describe("Markdown preview", () => {
  it("starts and stops the packaged CLI server without an agent-specific runtime", () => {
    const root = temporaryDirectory("preview-cli");
    writeFileSync(join(root, "spec.md"), "# Specification\n");
    const call = (...args: string[]) => JSON.parse(execFileSync(process.execPath,
      [at("cli/index.ts"), "preview", ...args, "--project", root, "--json"], { encoding: "utf8" })) as { status: string; data: Record<string, unknown> };
    const started = call("start", "spec.md");
    try {
      assert.equal(started.status, "success");
      assert.match(String(started.data.url), /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
      assert.equal(call("status", "spec.md").data.document, "spec.md");
    } finally { assert.equal(call("stop", "spec.md").data.stopped, true); }
  });

  it("serves safe Markdown, receives anchored comments, and approves only after resolution", async () => {
    const root = temporaryDirectory("preview");
    mkdirSync(join(root, "docs"));
    const file = join(root, "docs/plan.md");
    writeFileSync(file, "# Plan\n\nChoose **option A**. <script>alert(1)</script>\n");
    const server = await servePreview(root, at("."), "docs/plan.md");
    try {
      const denied = await fetch(`http://127.0.0.1:${server.port}/api/state`);
      assert.equal(denied.status, 403);
      const page = await api(server.port, server.token, "/api/state");
      const state = await page.json() as { html: string; sha: string; review: { revision: number } };
      assert.match(state.html, /<strong>option A<\/strong>/);
      assert.doesNotMatch(state.html, /<script>/);
      assert.equal((await api(server.port, server.token, "/api/comments", {
        quote: "option A", prefix: "Choose ", suffix: ".", offset: 13, body: "Explain this choice.",
        document_sha256: "0".repeat(64),
      })).status, 400);
      const posted = await api(server.port, server.token, "/api/comments", {
        quote: "option A", prefix: "Choose ", suffix: ".", offset: 13, body: "Explain this choice.",
        document_sha256: state.sha,
      });
      assert.equal(posted.status, 201);
      const comment = await posted.json() as { id: string };
      assert.equal((await api(server.port, server.token, "/api/approve", {
        document_sha256: state.sha, decided_by: "Anderson",
      })).status, 400);
      writeFileSync(file, "# Plan\n\nChoose **option A** because it is simpler.\n");
      const review = readReview(root, at("."), "docs/plan.md");
      assert.equal(review.comments.length, 1);
      resolveComment(review, comment.id);
      writeReview(root, at("."), review);
      assert.equal((await api(server.port, server.token, "/api/approve", {
        document_sha256: state.sha, decided_by: "Anderson",
      })).status, 409);
      const newSha = digest(readFileSync(file));
      assert.equal((await api(server.port, server.token, "/api/approve", {
        document_sha256: newSha, decided_by: "Anderson",
      })).status, 200);
      const approved = await (await api(server.port, server.token, "/api/state")).json() as { approved: boolean };
      assert.equal(approved.approved, true);
      assert.equal((await api(server.port, server.token, "/api/comments", {
        quote: "option A", prefix: "Choose ", suffix: " because", offset: 13, body: "Too late",
        document_sha256: newSha,
      })).status, 400);
    } finally {
      await api(server.port, server.token, "/api/stop", {});
    }
  });

  it("writes the existing workflow approval record only for the requested hash", async () => {
    const root = temporaryDirectory("preview-run");
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, ".paved/generated/runs"), { recursive: true });
    const file = join(root, "docs/plan.md");
    writeFileSync(file, "# Plan\n");
    const sha = digest(readFileSync(file));
    writeFileSync(join(root, ".paved/generated/runs/feature-123.yaml"), [
      "events:", "  - type: approval-requested", "    phase: planning", "    ref: docs/plan.md",
      "phases:", "  - phase: planning", "    gates:", "      - id: plan-approved", "        status: awaiting-approval",
      `        reason: plan_sha256=${sha}`, "",
    ].join("\n"));
    const server = await servePreview(root, at("."), "docs/plan.md", "feature-123");
    try {
      assert.equal((await api(server.port, server.token, "/api/approve", { document_sha256: sha, decided_by: "Anderson" })).status, 200);
      const approval = JSON.parse(readFileSync(join(root, ".paved/approvals/feature-123.json"), "utf8")) as { plan_sha256: string; decided_by: string };
      assert.equal(approval.plan_sha256, sha);
      assert.equal(approval.decided_by, "Anderson");
    } finally {
      await api(server.port, server.token, "/api/stop", {});
    }
  });
});
