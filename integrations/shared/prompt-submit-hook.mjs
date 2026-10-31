import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
    // A new or resumed session, compaction and clear each start without earlier guidance.
    if (["startup", "resume", "compact", "clear"].includes(event.source)) {
      emit("SessionStart", context);
    }
  } else if (event.hook_event_name === undefined || event.hook_event_name === "UserPromptSubmit") {
    emit("UserPromptSubmit", reminder);
  }
} catch {
  // This hook only adds guidance; any input or filesystem failure must leave the prompt unaffected.
  process.exit(0);
}
