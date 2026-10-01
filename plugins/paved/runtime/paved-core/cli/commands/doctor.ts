import { createDiagnostic, createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer } from "../lib/consumer-state.ts";
import { statusData } from "./status.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { repairProvider } from "../lib/decisions/providers/repair.ts";
import { repairHandler } from "../lib/decisions/handlers/repair.ts";

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
  const outcome = runDecisionGate({
    context: {
      projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
      command: "doctor", answers: invocation.flags.answers,
      ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
    },
    providers: [repairProvider], handlers: new Map([["repair.apply", repairHandler]]),
    persist: invocation.flags.answers.length > 0,
  });
  const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
    severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
    component: "cli.doctor", message,
    remediation: "Use the offered option id and provide the required human-authored approval.",
  }));

  return createResult({
    command: "doctor",
    status: statusFor([...inspection.diagnostics, ...decisionDiagnostics]),
    decisions: outcome.projections,
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
    diagnostics: [...inspection.diagnostics, ...decisionDiagnostics],
  });
}
