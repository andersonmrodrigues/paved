import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function nearestRepository(cwd) {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, ".paved", "manifest.yaml")) || existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

function stateRepository(repository) {
  if (existsSync(join(repository, ".paved", "manifest.yaml"))) return repository;
  try {
    const dotGit = join(repository, ".git");
    if (!lstatSync(dotGit).isFile()) return repository;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (!pointer) return repository;
    const gitDir = resolve(repository, pointer);
    const common = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
    if (common.split(sep).at(-1) !== ".git") return repository;
    const main = dirname(common);
    return existsSync(join(main, ".paved", "manifest.yaml")) ? main : repository;
  } catch { return repository; }
}

function invoke(repository, sourceRoot, args, timeout, allowedStatuses = [0, 1]) {
  // Never bootstrap a missing selection implicitly from a lifecycle hook.
  if (!existsSync(join(repository, ".paved", "paved.lock")) ||
      !existsSync(join(repository, ".paved", "runtime", "selection.json"))) return undefined;
  const launcher = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "paved.mjs");
  if (!existsSync(launcher)) return undefined;
  const child = spawnSync(process.execPath, [launcher, ...args, "--json", "--project", sourceRoot], {
    cwd: sourceRoot, encoding: "utf8", timeout, maxBuffer: 256 * 1024, shell: false,
  });
  if (child.error || child.status === null || !allowedStatuses.includes(child.status)) return undefined;
  try { return JSON.parse(child.stdout); } catch { return undefined; }
}

function openTasks(repository) {
  try {
    const dir = join(repository, ".paved", "tasks");
    if (lstatSync(dir).isSymbolicLink()) return [];
    return readdirSync(dir).filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)).sort().filter((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536 &&
        /^Status: open\r?$/m.test(readFileSync(path, "utf8"));
    }).slice(0, 3).map((name) => name.slice(0, 60));
  } catch { return []; }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (!event || typeof event !== "object" || typeof event.cwd !== "string") process.exit(0);
  if (!["SessionStart", "Stop"].includes(event.hook_event_name)) process.exit(0);
  const sourceRoot = nearestRepository(event.cwd);
  if (!sourceRoot) process.exit(0);
  const repository = stateRepository(sourceRoot);
  const initialized = existsSync(join(repository, ".paved", "manifest.yaml"));

  if (event.hook_event_name === "SessionStart") {
    const host = process.argv[2] === "--host" ? process.argv[3] : undefined;
    const update = initialized && ["claude-code", "codex"].includes(host)
      ? invoke(repository, sourceRoot, ["auto-update", "check", "--host", host], 300000, [0, 5])
      : undefined;
    const diagnosis = initialized ? invoke(repository, sourceRoot, ["doctor", "--quick"], 10000) : undefined;
    const status = !initialized ? (existsSync(join(repository, ".paved")) ? "broken" : "uninitialized") :
      typeof diagnosis?.data?.status === "string" && /^[a-z-]+$/.test(diagnosis.data.status) ? diagnosis.data.status : "unknown";
    const tasks = initialized ? openTasks(repository) : [];
    const lines = [
      `Paved: ${status}.`,
      tasks.length ? `Open task files: ${tasks.join(", ")} (select explicitly).` : "Open tasks: none listed.",
      "Rules: .paved/rules/; context: paved context <topic>.",
      "Work directly; respect user limits. Initialization is never automatic; updates require explicit authorization.",
    ];
    if (update?.data?.restartRequired === true) lines.push("Paved plugin updated; Restart this agent session.");
    else if (update?.status === "failed") lines.push("Paved plugin update did not complete; inspect `paved auto-update status` before retrying.");
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
  } else if (initialized) {
    const host = process.argv[2] === "--host" ? process.argv[3] : undefined;
    if (!["claude-code", "codex"].includes(host)) process.exit(0);
    const result = invoke(repository, sourceRoot, ["verify", "--changed"], 110000);
    const verified = result?.command === "verify" && ["success", "warning"].includes(result.status) &&
      result.data?.completion?.status === "complete" && result.data?.completion?.verification === "verified";
    if (!verified) {
      const reason = "NOT VERIFIED: paved verify --changed failed or could not complete. Inspect its output and correct or report the failure.";
      emit(event.stop_hook_active === true ? { systemMessage: reason } : { decision: "block", reason });
    }
  }
} catch {
  // Hooks must not crash the host on malformed input or filesystem errors.
}
