import { relative, sep } from "node:path";
import { runVerification } from "../lib/verification-runner.ts";
import { createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

function rel(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

export async function verifyHandler(invocation: CommandInvocation): Promise<CommandResult> {
  const result = await runVerification({
    projectRoot: invocation.paths.projectRoot,
    coreRoot: invocation.paths.coreRoot,
    adapterSelections: invocation.flags.adapters,
  });

  return createResult({
    command: "verify",
    status: statusFor(result.diagnostics),
    data: {
      checks: result.checks,
      evidence: result.evidenceFiles.map((file) => rel(invocation.paths.projectRoot, file)),
      completion: result.evaluation === undefined
        ? undefined
        : {
            status: result.evaluation.status,
            verification: result.evaluation.verification,
            blocking: result.evaluation.blocking,
            warnings: result.evaluation.warnings,
          },
    },
    diagnostics: result.diagnostics,
  });
}
