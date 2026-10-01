import { createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer, type ConsumerInspection } from "../lib/consumer-state.ts";
import { discoverAgentCommands } from "../lib/agent-commands.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

export function statusData(inspection: ConsumerInspection): Record<string, unknown> {
  const waiting = inspection.pendingDecisions.filter((item) => item.required);
  const unavailableCommands = discoverAgentCommands(inspection.projectRoot, inspection.coreRoot).commands
    .filter((command) => !command.available)
    .map((command) => ({
      name: command.name,
      reason: command.reason ?? "Unavailable in the current project state.",
      recommendedNextAction: command.recommendedNextAction ?? "Run paved status for guidance.",
    }));
  const answerCommand = `paved ${waiting[0]?.command ?? "status"}`;
  const nextAction = waiting.length > 0
    ? inspection.pendingApprovals.length > 0
      ? `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Review the pending approval ids, then relay approved answers with ${answerCommand} --answer <id>=<value>.`
      : `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Answer with ${answerCommand} --answer <id>=<value> --answered-by <you>.`
    : inspection.lifecycleState === "UNINITIALIZED" ? "Run paved init to initialize this project."
      : inspection.lifecycleState === "STALE" ? "Run paved update to refresh stale generated state."
        : inspection.lifecycleState === "BROKEN" || inspection.lifecycleState === "INCOMPATIBLE"
          ? "Run paved doctor to inspect and resolve the reported problems."
          : inspection.verificationProfile !== "present" ? "Run paved verify to choose repository checks."
            : "Run paved verify to check the project.";
  return {
    initialized: inspection.initialized,
    lifecycleState: inspection.lifecycleState,
    projectRoot: inspection.projectRoot,
    coreRoot: inspection.coreRoot,
    projectName: inspection.projectName,
    core: inspection.core,
    selectedAdapters: inspection.selectedAdapters,
    detectedAdapters: inspection.detectedAdapters,
    resolvedAdapters: inspection.resolvedAdapters,
    capabilityProviders: inspection.capabilityProviders,
    lockHealth: inspection.lockHealth,
    verificationProfile: inspection.verificationProfile,
    generatorState: inspection.lastRun ?? { present: false, proposals: [], conflicts: [] },
    proposals: inspection.proposals,
    conflicts: inspection.conflicts,
    pendingDecisions: inspection.pendingDecisions,
    pendingApprovals: inspection.pendingApprovals,
    verificationReadiness: inspection.verificationProfile === "present" ? "ready"
      : inspection.pendingDecisions.length > 0 ? "awaiting-decision" : "unconfigured",
    unavailableCommands,
    nextAction,
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
