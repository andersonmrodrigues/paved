import { createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer, type ConsumerInspection } from "../lib/consumer-state.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

export function statusData(inspection: ConsumerInspection): Record<string, unknown> {
  return {
    initialized: inspection.initialized,
    projectRoot: inspection.projectRoot,
    coreRoot: inspection.coreRoot,
    projectName: inspection.projectName,
    core: inspection.core,
    selectedAdapters: inspection.selectedAdapters,
    detectedAdapters: inspection.detectedAdapters,
    resolvedAdapters: inspection.resolvedAdapters,
    lockHealth: inspection.lockHealth,
    verificationProfile: inspection.verificationProfile,
    generatorState: inspection.lastRun ?? { present: false, proposals: [], conflicts: [] },
    proposals: inspection.proposals,
    conflicts: inspection.conflicts,
  };
}

export function statusHandler(invocation: CommandInvocation): CommandResult {
  const inspection = inspectConsumer({
    projectRoot: invocation.paths.projectRoot,
    coreRoot: invocation.paths.coreRoot,
    adapterSelections: invocation.flags.adapters,
    ...(invocation.paths.manifestPath === undefined ? {} : { manifestPath: invocation.paths.manifestPath }),
  });

  return createResult({
    command: "status",
    status: statusFor(inspection.diagnostics),
    data: statusData(inspection),
    diagnostics: inspection.diagnostics,
  });
}
