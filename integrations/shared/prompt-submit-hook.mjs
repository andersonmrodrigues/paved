import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const context = [
  "Paved routing for this repository:",
  "- For repository changes, testing, planning, or review, consult Paved state and use the matching available Paved command or workflow.",
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

try {
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

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  })}\n`);
} catch {
  // This hook only adds guidance; any input or filesystem failure must leave the prompt unaffected.
  process.exit(0);
}
