import { analyzeGardener, GardenerInputError } from "../lib/gardener.ts";
import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";

export function gardenerHandler(invocation: CommandInvocation): CommandResult {
  try {
    const result = analyzeGardener(invocation.paths);
    const count = result.proposals.filter((proposal) => proposal.status === "CANDIDATE").length;
    return createResult({
      command: "gardener", status: count > 0 ? "warning" : "success",
      data: { ...result, dryRun: invocation.flags.dryRun, approvalRequired: true },
      diagnostics: count > 0 ? [createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_GARDENER_PROPOSALS", component: "gardener",
        message: `${count} improvement proposal(s) require human review.`,
      })] : [],
    });
  } catch (error) {
    return createResult({ command: "gardener", status: "failed", diagnostics: [createDiagnostic({
      severity: "error", category: error instanceof GardenerInputError ? "config" : "internal",
      code: error instanceof GardenerInputError ? "PAVED_GARDENER_INPUT" : "PAVED_GARDENER_FAILURE",
      component: "gardener", message: error instanceof GardenerInputError ? error.message : "Gardener analysis failed.",
    })] });
  }
}
