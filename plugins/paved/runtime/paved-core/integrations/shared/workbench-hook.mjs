import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function repository(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".paved", "manifest.yaml"))) return current;
    if (existsSync(join(current, ".git"))) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

try {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (!event || typeof event !== "object" || typeof event.cwd !== "string" || typeof event.session_id !== "string") process.exit(0);
  const root = repository(event.cwd);
  if (!root || !existsSync(join(root, ".paved", "paved.lock"))) process.exit(0);
  const statePath = join(root, ".paved/generated/workbench/server.json");
  if (!existsSync(statePath)) process.exit(0);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.token !== "string") process.exit(0);
  const name = typeof event.hook_event_name === "string" ? event.hook_event_name : event.type;
  if (!["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd", "Interrupt"].includes(name)) process.exit(0);
  const payload = {
    agent: process.env.PLUGIN_ROOT ? "codex" : "claude-code",
    session: createHash("sha256").update(event.session_id).digest("hex"),
    event: name,
    ...(typeof event.tool_name === "string" ? { tool: event.tool_name } : {}),
  };
  await fetch(`http://127.0.0.1:${state.port}/api/activity`, {
    method: "POST", headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(350),
  }).catch(() => undefined);
} catch {
  // Observability is optional; hook failures must never interrupt the agent.
}
