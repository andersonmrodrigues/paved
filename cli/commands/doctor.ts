import { createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer } from "../lib/consumer-state.ts";
import { statusData } from "./status.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

export function doctorHandler(invocation: CommandInvocation): CommandResult {
  const inspection = inspectConsumer({
    projectRoot: invocation.paths.projectRoot,
    coreRoot: invocation.paths.coreRoot,
    adapterSelections: invocation.flags.adapters,
    ...(invocation.paths.manifestPath === undefined ? {} : { manifestPath: invocation.paths.manifestPath }),
  });

  return createResult({
    command: "doctor",
    status: statusFor(inspection.diagnostics),
    data: {
      ...statusData(inspection),
      actionableFindings: inspection.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        category: diagnostic.category,
        component: diagnostic.component,
        message: diagnostic.message,
        remediation: diagnostic.remediation,
      })),
    },
    diagnostics: inspection.diagnostics,
  });
}
