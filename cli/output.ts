import { exitCode, primaryCategory, type CommandResult, type DecisionProjection } from "./result.ts";

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

  const decisions = renderDecisions(result);
  if (decisions !== "") {
    lines.push("", decisions);
  }

  return `${lines.join("\n")}\n`;
}

function renderDecision(decision: DecisionProjection, command: string): string {
  const lines: string[] = [];
  lines.push(`  [${decision.id}] ${decision.question}${decision.required ? "" : "  (optional)"}`);
  lines.push(`    ${decision.reason}`);
  for (const [index, option] of decision.options.entries()) {
    const mark = option.id === decision.recommended ? "  (recommended)" : "";
    lines.push(`    ${index + 1}. ${option.id} — ${option.label}${mark}`);
    lines.push(`       ${option.consequence}`);
  }
  if (decision.recommended !== undefined && decision.evidence.length > 0) {
    lines.push(`    Recommended because of: ${decision.evidence.map((item) => item.location).join(", ")}`);
  }
  if (decision.answerChannel === "human-authored") {
    lines.push("    This decision is irreversible, so a person must author");
    lines.push(`    .paved/approvals/${decision.id}.json before it can be applied.`);
  } else {
    const run = decision.runId === undefined ? "" : ` --run ${decision.runId}`;
    lines.push(`    Resume: paved ${command}${run} --answer ${decision.id}=<option> --answered-by <you>`);
  }
  return lines.join("\n");
}

export function renderDecisions(result: CommandResult): string {
  const decisions = result.decisions ?? [];
  if (decisions.length === 0) return "";
  const required = decisions.filter((item) => item.required).length;
  const heading = required > 0
    ? `Paved needs ${required} decision${required === 1 ? "" : "s"} before continuing:`
    : "Paved has optional proposals for you:";
  return [heading, "", ...decisions.map((item) => renderDecision(item, result.command))].join("\n");
}
