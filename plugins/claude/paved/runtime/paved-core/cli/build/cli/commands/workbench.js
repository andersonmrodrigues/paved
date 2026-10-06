import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDiagnostic, createResult } from "../result.js";
import { workbenchInfoPath } from "../lib/workbench-server.js";
const USAGE = "Use paved workbench start|status|stop.";
function failure(message) {
    return createResult({ command: "workbench", status: "failed", diagnostics: [createDiagnostic({
                severity: "error", category: "usage", code: "PAVED_WORKBENCH_ERROR", component: "cli.commands.workbench", message,
            })] });
}
function info(root) {
    const path = workbenchInfoPath(root);
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
async function alive(value) {
    try {
        return (await fetch(`http://127.0.0.1:${value.port}/api/state`, { headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(800) })).ok;
    }
    catch {
        return false;
    }
}
function details(value) { return { url: `http://127.0.0.1:${value.port}/?token=${value.token}`, port: value.port }; }
export async function workbenchHandler(invocation) {
    const [operation] = invocation.selectors;
    const { projectRoot: root } = invocation.paths;
    if (!operation)
        return failure(USAGE);
    try {
        const current = info(root);
        if (operation === "status")
            return createResult({ command: "workbench", status: "success", data: {
                    running: current ? await alive(current) : false, ...(current ? details(current) : {}),
                } });
        if (operation === "start") {
            if (!existsSync(resolve(root, ".paved/manifest.yaml")) || !existsSync(resolve(root, ".paved/paved.lock"))) {
                return failure("Initialize Paved in this repository before starting the Workbench.");
            }
            if (current && await alive(current))
                return createResult({ command: "workbench", status: "success", data: details(current) });
            const path = workbenchInfoPath(root);
            if (existsSync(path))
                rmSync(path);
            const args = [resolve(process.cwd(), process.argv[1]), "workbench", "serve", "--project", root, "--json"];
            const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: "ignore" });
            child.unref();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                await delay(100);
                const started = info(root);
                if (started && await alive(started))
                    return createResult({ command: "workbench", status: "success", data: details(started) });
            }
            return failure("Workbench did not start. Run paved workbench serve to inspect the error.");
        }
        if (operation === "serve") {
            const { serveWorkbench } = await import("../lib/workbench-server.js");
            const started = await serveWorkbench(root, invocation.paths.coreRoot);
            return createResult({ command: "workbench", status: "success", data: details(started) });
        }
        if (operation === "stop") {
            if (current && await alive(current))
                await fetch(`http://127.0.0.1:${current.port}/api/stop`, {
                    method: "POST", headers: { authorization: `Bearer ${current.token}` }, signal: AbortSignal.timeout(800),
                });
            return createResult({ command: "workbench", status: "success", data: { stopped: true } });
        }
        return failure(`Unknown workbench operation: ${operation}. ${USAGE}`);
    }
    catch (cause) {
        return failure(cause instanceof Error ? cause.message : "Workbench failed.");
    }
}
