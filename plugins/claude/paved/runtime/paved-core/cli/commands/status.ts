import { createDiagnostic, createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer, type ConsumerInspection } from "../lib/consumer-state.ts";
import { discoverAgentCommands } from "../lib/agent-commands.ts";
import { agentsBlockInvalidDiagnostic, inspectAgentsBlock } from "../lib/agents-block.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { DecisionStoreError } from "../lib/decisions/store.ts";
import { repairProvider } from "../lib/decisions/providers/repair.ts";
import { repairHandler } from "../lib/decisions/handlers/repair.ts";
import { isOpen, listRuns } from "../lib/workflow-runs.ts";

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
  const answerCommand = `paved ${waiting[0]?.command === "doctor" ? "status" : waiting[0]?.command ?? "status"}`;
  const nextAction = waiting.length > 0
    ? inspection.pendingApprovals.length > 0
      ? `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Review the pending approval ids, then relay approved answers with ${answerCommand} --answer <id>=<value>.`
      : `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Answer with ${answerCommand} --answer <id>=<value> --answered-by <you>.`
    : inspection.lifecycleState === "UNINITIALIZED" ? "Run paved init to initialize this project."
      : inspection.lifecycleState === "STALE" ? "Run paved update to refresh stale generated state."
        : inspection.lifecycleState === "BROKEN" || inspection.lifecycleState === "INCOMPATIBLE"
          ? "Run paved status and answer its repair decisions."
          : inspection.verificationProfile !== "present" ? "Run paved verify to choose repository checks."
            : 'Start work with paved intent "<request>" --json.';
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

function agentsBlockFindings(inspection: ConsumerInspection): Diagnostic[] {
  if (!inspection.initialized) return [];
  const agents = inspectAgentsBlock(inspection.coreRoot, inspection.projectRoot);
  if (agents.state === "invalid") return [agentsBlockInvalidDiagnostic(agents.reason)];
  if (agents.state !== "outdated") return [];
  return [createDiagnostic({
    severity: "warning", category: "findings", code: "PAVED_AGENTS_BLOCK_OUTDATED", component: "consumer.agents",
    message: "The managed Paved block in AGENTS.md differs from the current Core template.",
    remediation: "Run paved update to rewrite the managed block; text outside it is never changed.",
  })];
}

function openRuns(inspection: ConsumerInspection): { runs: Record<string, unknown>[]; diagnostics: Diagnostic[] } {
  if (!inspection.initialized) return { runs: [], diagnostics: [] };
  try {
    const runs = listRuns(inspection.projectRoot, inspection.coreRoot).filter(isOpen).map((run) => ({
      run: run.id, status: run.status, ...(run.workflow === undefined ? {} : { workflow: run.workflow.id }),
      currentPhase: run.phases.find((phase) => phase.status === "running")?.phase,
    }));
    return { runs, diagnostics: [] };
  } catch (error) {
    return { runs: [], diagnostics: [createDiagnostic({
      severity: "warning", category: "findings", code: "PAVED_WORKFLOW_RUN_INVALID", component: "consumer.runs",
      message: `A workflow run could not be read: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Inspect .paved/generated/runs/ and restore or remove the invalid run document.",
    })] };
  }
}

/** An unreadable decision store is already reported by the inspection; repairs then wait for it to be fixed. */
function repairs(invocation: CommandInvocation): { projections: ReturnType<typeof runDecisionGate>["projections"]; problems: readonly string[] } {
  try {
    return runDecisionGate({
      context: {
        projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
        command: "doctor", answers: invocation.flags.answers,
        ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
      },
      providers: [repairProvider], handlers: new Map([["repair.apply", repairHandler]]),
      persist: invocation.flags.answers.length > 0,
    });
  } catch (error) {
    if (!(error instanceof DecisionStoreError)) throw error;
    return { projections: [], problems: [] };
  }
}

/** `status` and the `doctor` CLI subcommand share this; repairs keep the `doctor` decision ids. */
export function diagnose(invocation: CommandInvocation, command: "status" | "doctor"): CommandResult {
  const inspection = inspectConsumer({
    projectRoot: invocation.paths.projectRoot,
    coreRoot: invocation.paths.coreRoot,
    adapterSelections: invocation.flags.adapters,
    ...(invocation.paths.manifestPath === undefined ? {} : { manifestPath: invocation.paths.manifestPath }),
  });
  const outcome = repairs(invocation);
  const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
    severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
    component: `cli.${command}`, message,
    remediation: "Use the offered option id and provide the required human-authored approval.",
  }));
  const runs = openRuns(inspection);
  const diagnostics = [...inspection.diagnostics, ...agentsBlockFindings(inspection), ...runs.diagnostics, ...decisionDiagnostics];
  return createResult({
    command,
    status: statusFor(diagnostics),
    decisions: outcome.projections,
    data: {
      ...statusData(inspection),
      openRuns: runs.runs,
      actionableFindings: diagnostics.filter((item) => item.code !== "PAVED_DECISION_ANSWER_INVALID").map((diagnostic) => ({
        code: diagnostic.code, severity: diagnostic.severity, category: diagnostic.category,
        component: diagnostic.component, message: diagnostic.message, remediation: diagnostic.remediation,
      })),
    },
    diagnostics,
  });
}

export function statusHandler(invocation: CommandInvocation): CommandResult {
  return diagnose(invocation, "status");
}
