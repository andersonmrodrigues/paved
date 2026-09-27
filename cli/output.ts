import { exitCode, primaryCategory, type CommandResult } from "./result.ts";

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === "stack") {
        continue;
      }
      output[key] = sanitize(child);
    }
    return output;
  }

  return value;
}

export function renderJson(result: CommandResult): string {
  return JSON.stringify(sanitize(result), null, 2);
}

export function renderHuman(result: CommandResult): string {
  const lines = [
    `${result.command}: ${result.status}`,
    `primary: ${primaryCategory(result)} (exit ${exitCode(result)})`,
  ];

  for (const diagnostic of result.diagnostics) {
    lines.push(`[${diagnostic.severity}] ${diagnostic.code} ${diagnostic.component}: ${diagnostic.message}`);
    if (diagnostic.remediation !== undefined) {
      lines.push(`  remediation: ${diagnostic.remediation}`);
    }
  }

  if (result.data !== undefined) {
    lines.push(`data: ${JSON.stringify(sanitize(result.data))}`);
  }

  return `${lines.join("\n")}\n`;
}
