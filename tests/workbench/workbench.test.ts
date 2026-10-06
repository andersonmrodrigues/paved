import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { serveWorkbench, workbenchInfoPath } from "../../cli/lib/workbench-server.ts";
import { at, cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

after(cleanupTemporaryDirectories);

async function api(port: number, token: string, route: string, value?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, { method: value === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(value === undefined ? {} : { "content-type": "application/json" }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}

describe("Paved Workbench", () => {
  it("serves a token-protected local dashboard with workflow state", async () => {
    const root = temporaryDirectory("workbench-server");
    const server = await serveWorkbench(root, at("."));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status, 403);
      const page = await fetch(`http://127.0.0.1:${server.port}/?token=${server.token}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Trabalho em andamento/);
      assert.equal((await api(server.port, server.token, "/workbench.css")).status, 200);
      const script = await api(server.port, server.token, "/workbench.js");
      assert.equal(script.status, 200);
      assert.match(await script.text(), /Copiar próximo comando/);
      assert.equal((await api(server.port, server.token, "/api/state")).status, 200);
    } finally { await api(server.port, server.token, "/api/stop", {}); }
  });

  it("accepts only hashed lifecycle activity and returns it with current runs", async () => {
    const root = temporaryDirectory("workbench-activity");
    const server = await serveWorkbench(root, at("."));
    try {
      assert.equal((await api(server.port, server.token, "/api/activity", { agent: "codex", session: "raw-session", event: "Stop" })).status, 400);
      const event = { agent: "claude-code", session: "a".repeat(64), event: "PostToolUse", tool: "Edit", prompt: "must not be stored" };
      assert.equal((await api(server.port, server.token, "/api/activity", event)).status, 202);
      const state = await (await api(server.port, server.token, "/api/state")).json() as { activity: { session: string; event: string; tool?: string }[] };
      assert.deepEqual(state.activity.map(({ session, event: name, tool }) => ({ session, event: name, tool })), [{ session: event.session, event: "PostToolUse", tool: "Edit" }]);
      assert.equal(JSON.stringify(state).includes("must not be stored"), false);
    } finally { await api(server.port, server.token, "/api/stop", {}); }
  });

  it("tracks agent activity through hooks only while the workbench is running", async () => {
    const root = temporaryDirectory("workbench-hook");
    mkdirSync(join(root, ".paved"), { recursive: true });
    writeFileSync(join(root, ".paved/manifest.yaml"), "version: test\n");
    writeFileSync(join(root, ".paved/paved.lock"), "version: test\n");
    const input = JSON.stringify({ cwd: root, session_id: "session-secret", hook_event_name: "PostToolUse", tool_name: "Edit", prompt: "private content" });
    const script = at("integrations/shared/workbench-hook.mjs");
    const idle = spawnSync(process.execPath, [script], { input, encoding: "utf8" });
    assert.equal(idle.status, 0);
    assert.equal(idle.stdout, "");
    assert.equal(existsSync(workbenchInfoPath(root)), false);

    const server = await serveWorkbench(root, at("."));
    try {
      const result = spawnSync(process.execPath, [script], { input, encoding: "utf8", env: { ...process.env, PLUGIN_ROOT: "/codex/plugin" } });
      assert.equal(result.status, 0, result.stderr);
      const state = await (await api(server.port, server.token, "/api/state")).json() as { activity: { agent: string; session: string; tool?: string }[] };
      assert.equal(state.activity[0]?.agent, "codex");
      assert.equal(state.activity[0]?.session.length, 64);
      assert.notEqual(state.activity[0]?.session, "session-secret");
      assert.equal(state.activity[0]?.tool, "Edit");
      assert.equal(JSON.stringify(state).includes("private content"), false);
    } finally { await api(server.port, server.token, "/api/stop", {}); }
  });

  it("starts and stops through the CLI", () => {
    const root = temporaryDirectory("workbench-cli");
    mkdirSync(join(root, ".paved"), { recursive: true });
    writeFileSync(join(root, ".paved/manifest.yaml"), "version: test\n");
    writeFileSync(join(root, ".paved/paved.lock"), "version: test\n");
    const call = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [at("cli/index.ts"), "workbench", ...args, "--project", root, "--json"], { encoding: "utf8" })) as { status: string; data: Record<string, unknown> };
    const started = call("start");
    try {
      assert.equal(started.status, "success");
      assert.match(String(started.data.url), /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
      assert.equal(call("status").data.running, true);
    } finally { assert.equal(call("stop").data.stopped, true); }
  });

});
