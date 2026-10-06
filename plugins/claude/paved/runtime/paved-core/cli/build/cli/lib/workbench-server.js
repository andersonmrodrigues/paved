import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { scanRuns } from "./workflow-runs.js";
export function workbenchInfoPath(root) { return join(root, ".paved/generated/workbench/server.json"); }
function json(response, code, value) {
    response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
}
function error(response, code, message) { json(response, code, { error: message }); }
function parseBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > 4096) {
                reject(new Error("Activity event is too large."));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!value || typeof value !== "object" || Array.isArray(value))
                    throw new Error("Expected a JSON object.");
                resolve(value);
            }
            catch (cause) {
                reject(cause);
            }
        });
        request.on("error", reject);
    });
}
export async function serveWorkbench(root, coreRoot) {
    const token = randomBytes(24).toString("hex");
    const infoPath = workbenchInfoPath(root);
    const sessions = new Map();
    let port = 0;
    const server = createServer(async (request, response) => {
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
        try {
            const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
            if (request.headers.host !== `127.0.0.1:${port}`)
                return error(response, 403, "Invalid host.");
            const cookieName = `paved_workbench_${port}`;
            const authorized = request.headers.authorization === `Bearer ${token}` || request.headers.cookie?.split(/;\s*/).includes(`${cookieName}=${token}`);
            if (url.pathname === "/" && request.method === "GET") {
                if (url.searchParams.get("token") !== token && !authorized)
                    return error(response, 403, "Invalid workbench token.");
                response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/` });
                response.end(readFileSync(join(coreRoot, "cli/assets/workbench.html"), "utf8"));
                return;
            }
            if (["/workbench.css", "/workbench.js"].includes(url.pathname) && request.method === "GET") {
                if (!authorized)
                    return error(response, 403, "Invalid workbench token.");
                const file = url.pathname.endsWith(".css") ? "workbench.css" : "workbench.js";
                response.writeHead(200, { "content-type": file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "cache-control": "no-store" });
                response.end(readFileSync(join(coreRoot, "cli/assets", file)));
                return;
            }
            if (!authorized)
                return error(response, 403, "Invalid workbench token.");
            if (url.pathname === "/api/state" && request.method === "GET") {
                const { runs, unreadable } = scanRuns(root, coreRoot);
                return json(response, 200, { runs: runs.sort((a, b) => b.started_at.localeCompare(a.started_at)), unreadable,
                    activity: [...sessions.values()].sort((a, b) => b.at.localeCompare(a.at)) });
            }
            if (url.pathname === "/api/activity" && request.method === "POST" && request.headers.authorization === `Bearer ${token}`) {
                const value = await parseBody(request);
                if (!["claude-code", "codex"].includes(String(value.agent)) || typeof value.session !== "string" || !/^[a-f0-9]{64}$/.test(value.session)
                    || !["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd", "Interrupt"].includes(String(value.event))) {
                    return error(response, 400, "Invalid activity event.");
                }
                const entry = { agent: String(value.agent), session: value.session, event: String(value.event), at: new Date().toISOString(),
                    ...(typeof value.tool === "string" && /^[\w.-]{1,80}$/.test(value.tool) ? { tool: value.tool } : {}) };
                sessions.set(`${entry.agent}:${entry.session}`, entry);
                while (sessions.size > 100)
                    sessions.delete(sessions.keys().next().value);
                return json(response, 202, { accepted: true });
            }
            if (url.pathname === "/api/stop" && request.method === "POST" && request.headers.authorization === `Bearer ${token}`) {
                json(response, 200, { stopped: true });
                server.close();
                return;
            }
            error(response, 404, "Unknown workbench endpoint.");
        }
        catch (cause) {
            error(response, 400, cause instanceof Error ? cause.message : "Workbench request failed.");
        }
    });
    server.on("close", () => { if (existsSync(infoPath))
        rmSync(infoPath); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Workbench server has no port.");
    port = address.port;
    const info = { pid: process.pid, port, token };
    mkdirSync(dirname(infoPath), { recursive: true });
    atomicWriteFileSync(infoPath, `${JSON.stringify(info)}\n`);
    return info;
}
