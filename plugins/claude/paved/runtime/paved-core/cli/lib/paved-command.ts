import type { CommandResult } from "../result.ts";
import { COMMAND_NAMES } from "../runtime.ts";

// A remediation may name any CLI command, or the launcher's own `runtime`.
const MENTION = new RegExp(`(^|[\\s\`'"(])paved (?=(?:${[...COMMAND_NAMES, "runtime"].join("|")})\\b)`, "g");
const GUIDANCE_KEYS = new Set(["nextAction", "next_action", "remediation", "recommendedNextAction"]);

function rewrite(value: unknown, command: string, guidance: boolean): unknown {
  if (typeof value === "string") return guidance ? value.replace(MENTION, (_match, lead: string) => `${lead}${command} `) : value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, command, guidance));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, command, guidance || GUIDANCE_KEYS.has(key))]));
}

/**
 * Replaces `paved <command>` in remediation and next-action texts with the command that
 * actually runs Paved for this project, so the text can be pasted as is. The launcher
 * passes that command in PAVED_COMMAND; without it the texts keep the bare `paved`.
 */
export function withPavedCommand(result: CommandResult, command: string | undefined): CommandResult {
  const prefix = command?.trim();
  if (!prefix || /[\r\n]/.test(prefix) || prefix === "paved") return result;
  return rewrite(result, prefix, false) as CommandResult;
}
