import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { addProjectCheck } from "../lib/decisions/handlers/verification.ts";
import { inspectVerificationConfig } from "../lib/verification-runner.ts";

const USAGE = "Use paved tool add <check-type> [label] [--scope <dir>] -- <executable> [args...].";

function failure(code: string, message: string, remediation = USAGE): CommandResult {
  return createResult({ command: "tool", status: "failed", diagnostics: [createDiagnostic({
    severity: "error", category: code === "PAVED_TOOL_USAGE" ? "usage" : "config", code, component: "cli.commands.tool", message, remediation,
  })] });
}

/** `paved tool add` turns one explicit command into a Tool, its binding and a Check in a single validated write. */
export function toolHandler(invocation: CommandInvocation): CommandResult {
  const [operation, type, ...label] = invocation.selectors;
  const argv = invocation.flags.toolCommand ?? [];
  if (operation !== "add" || !type || argv.length === 0) return failure("PAVED_TOOL_USAGE", "paved tool add needs a check type and a command after --.");
  const { projectRoot, coreRoot } = invocation.paths;
  if (!existsSync(join(projectRoot, ".paved/manifest.yaml"))) {
    return failure("PAVED_TOOL_UNINITIALIZED", "Paved is not initialized in this repository.", "Run paved init --json, then repeat this command.");
  }
  const [executable, ...args] = argv as [string, ...string[]];
  const name = label.length > 0 ? label.join(" ") : argv.join(" ");
  try {
    const added = addProjectCheck(projectRoot, coreRoot, {
      id: `tool-${type}-${name}`, label: name, command: executable, scope: invocation.flags.scope ?? ".",
      type, argv: { executable, args },
    });
    const findings = inspectVerificationConfig({ projectRoot, coreRoot });
    return createResult({
      command: "tool",
      status: findings.length > 0 ? "failed" : "success",
      data: { check: added.checkId, files: added.files, nextAction: "Run paved verify --json to execute the profile." },
      diagnostics: findings,
    });
  } catch (error) {
    return failure("PAVED_TOOL_INVALID", error instanceof Error ? error.message : "The Tool could not be written.",
      "Use a check type from the Check schema (for example unit, build, static-analysis) and a command that exists.");
  }
}
