import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const context = [
  "Paved routing for this repository:",
  "- Use Paved by default for development, planning, fixes, debugging and refactoring, even without an explicit Paved command. Before starting, consult Paved status and resume the matching run when continuing the same request; do not create a duplicate or reuse an unrelated run.",
  "- For a new repository change, start with the Paved `intent` command and the user's request verbatim, then follow its next action through `plan` and `execute`. Classify from evidence, not keywords alone; present any unresolved decisions to the user.",
  "- For planning-only requests, stop at the plan; for investigation-only requests, use the bug investigation guidance and do not implement a fix. Implementation requires explicit human approval of the current plan; a request to develop or debug is not that approval.",
  "- For testing, review or state, consult Paved state and use the matching available Paved command.",
  "- To write, fill in, or review a task, issue, ticket, story, bug, or epic for this repository, including one given by link, use paved:task-specification to write or fill it in and paved:task-review to review it.",
  "- For repository-specific questions, consult only the relevant Paved context and answer directly; do not create a workflow when none is needed.",
  "- For requests unrelated to this repository, proceed normally without invoking Paved.",
  "- Respect explicit user direction. If a required Paved command is unavailable, explain the blocker rather than silently substituting an undeclared process.",
  "- Each intent, plan and execute result carries `routing` for the current phase: run a `subagent` phase in a host subagent at that capacity and reasoning effort, giving it only a bounded brief and asking for findings rather than file contents; keep a `primary` phase in this session; only relay a `cli` phase. `paved delegation capabilities --host <host>` maps the tiers to the host's models.",
].join("\n");

// Every prompt gets this line; the full guidance above comes once per session and after compaction.
const reminder = "Paved: route repository development, planning, fixes, debugging and refactoring through intent, plan and execute (explicit human approval of the plan before implementing), resume the matching run, and follow each result's `routing`. Unrelated requests proceed normally.";

function nearestRepository(cwd) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".paved", "manifest.yaml")) || existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`);
}

function stateRepository(repository) {
  if (existsSync(join(repository, ".paved/manifest.yaml"))) return repository;
  try {
    const dotGit = join(repository, ".git");
    if (!lstatSync(dotGit).isFile()) return repository;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (!pointer) return repository;
    const gitDir = resolve(repository, pointer);
    const common = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
    if (common.split(sep).at(-1) !== ".git") return repository;
    const main = dirname(common);
    return existsSync(join(main, ".paved/manifest.yaml")) ? main : repository;
  } catch { return repository; }
}

async function checkAuthorizedUpdate(repository, sourceRoot) {
  // Identity comes from the installed hook declaration, never a repository setting.
  const host = process.argv[2] === "--host" ? process.argv[3] : undefined;
  if (!["claude-code", "codex"].includes(host)) return;
  const pluginRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
  if (host === "codex") {
    // Codex supplies PLUGIN_ROOT for plugin hooks. CODEX_HOME by itself can be
    // inherited by Cursor and is not proof of the initiating host.
    const cache = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "plugins/cache/paved/paved");
    const rel = relative(cache, pluginRoot);
    if (process.env.PLUGIN_ROOT !== pluginRoot || !rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(cache, rel) !== pluginRoot) return;
  }
  if (!existsSync(join(repository, ".paved/auto-update.json"))) return;
  const { autoUpdate } = await import("../scripts/auto-update.mjs");
  const result = autoUpdate({ projectRoot: repository, sourceRoot, pluginRoot, argv: ["check", "--host", host] });
  if (result.status === "failed" || ["updated", "notification"].includes(result.data.reason)) {
    process.stderr.write(`${JSON.stringify({ autoUpdate: result })}\n`);
  }
  if (result.data.reason === "updated") return "Paved automatic update finished. Restart this agent session to load refreshed skills/hooks; current-session definitions have not been replaced.";
  if (result.data.reason === "notification") return "Paved update notification checked installed inventory only; upstream freshness is unknown. No plugin or runtime was updated.";
  if (result.status === "failed") return `Paved automatic update failed after [${result.data.completed.join(", ")}]. Project adoption was not confirmed; inspect the diagnostics. Completed host refresh steps are not rolled back.`;
}

try {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (event === null || typeof event !== "object" || Array.isArray(event) || typeof event.cwd !== "string") {
    process.exit(0);
  }
  const sourceRoot = nearestRepository(event.cwd);
  const repository = sourceRoot === undefined ? undefined : stateRepository(sourceRoot);
  if (repository === undefined ||
      !existsSync(join(repository, ".paved", "manifest.yaml")) ||
      !existsSync(join(repository, ".paved", "paved.lock"))) {
    process.exit(0);
  }
  let updateNotice;
  if (event.hook_event_name === undefined || ["SessionStart", "UserPromptSubmit"].includes(event.hook_event_name)) {
    try { updateNotice = await checkAuthorizedUpdate(repository, sourceRoot); } catch { /* Update failures must not suppress routing guidance. */ }
  }
  if (event.hook_event_name === "SessionStart") {
    // A new or resumed session, compaction and clear each start without earlier guidance.
    if (["startup", "resume", "compact", "clear"].includes(event.source)) {
      emit("SessionStart", updateNotice ? `${context}\n${updateNotice}` : context);
    }
  } else if (event.hook_event_name === undefined || event.hook_event_name === "UserPromptSubmit") {
    emit("UserPromptSubmit", updateNotice ? `${reminder}\n${updateNotice}` : reminder);
  }
} catch {
  // This hook only adds guidance; any input or filesystem failure must leave the prompt unaffected.
  process.exit(0);
}
