import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const context = [
  "Paved routing for this repository:",
  "- For repository changes (a feature, a bug fix or a refactor), start with the Paved `intent` command and the user's request verbatim, then follow its next action through `plan` and `execute`. For testing, review or state, consult Paved state and use the matching available Paved command.",
  "- To write, fill in, or review a task, issue, ticket, story, bug, or epic for this repository, including one given by link, use paved:task-specification to write or fill it in and paved:task-review to review it.",
  "- For repository-specific questions, consult only the relevant Paved context and answer directly; do not create a workflow when none is needed.",
  "- For requests unrelated to this repository, proceed normally without invoking Paved.",
  "- Respect explicit user direction. If a required Paved command is unavailable, explain the blocker rather than silently substituting an undeclared process.",
].join("\n");

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

/**
 * Records that this session already received the guidance for this repository and
 * reports whether it is the first time. The marker holds no prompt text. When it cannot
 * be recorded, the guidance is repeated rather than lost.
 */
function firstInSession(sessionId, repository) {
  if (typeof sessionId !== "string" || sessionId === "") return true;
  const key = createHash("sha256").update(`${sessionId}\0${repository}`).digest("hex");
  try {
    const directory = join(tmpdir(), "paved-hook-sessions");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, key), "", { flag: "wx" });
    return true;
  } catch (error) {
    return error?.code !== "EEXIST";
  }
}

function emit(hookEventName) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } })}\n`);
}

try {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (event === null || typeof event !== "object" || Array.isArray(event) || typeof event.cwd !== "string") {
    process.exit(0);
  }
  const repository = nearestRepository(event.cwd);
  if (repository === undefined ||
      !existsSync(join(repository, ".paved", "manifest.yaml")) ||
      !existsSync(join(repository, ".paved", "paved.lock"))) {
    process.exit(0);
  }
  if (event.hook_event_name === "SessionStart") {
    // Compaction and clear drop earlier context, so the guidance is restored there.
    if (event.source === "compact" || event.source === "clear") {
      firstInSession(event.session_id, repository);
      emit("SessionStart");
    }
  } else if (firstInSession(event.session_id, repository)) {
    emit("UserPromptSubmit");
  }
} catch {
  // This hook only adds guidance; any input or filesystem failure must leave the prompt unaffected.
  process.exit(0);
}
