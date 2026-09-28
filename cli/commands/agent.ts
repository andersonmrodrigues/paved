import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { acquireConsumerOperationLock } from "../lib/operation-lock.ts";
import { applyProjection, planProjection, removeProjection } from "../../integrations/shared/projection.ts";
import type { AgentId } from "../../integrations/shared/types.ts";

function agentId(value: string | undefined): AgentId | undefined {
  return value === "codex" || value === "claude-code" ? value : undefined;
}

export function agentHandler(invocation: CommandInvocation): CommandResult {
  const [operation = "list", selected] = invocation.selectors;
  if (operation === "list") {
    return createResult({
      command: "agent",
      status: "success",
      data: { integrations: ["codex", "claude-code"] },
    });
  }
  const agent = agentId(selected ?? operation);
  const action = selected === undefined ? "status" : operation;
  if (!agent) {
    return createResult({
      command: "agent",
      status: "failed",
      diagnostics: [createDiagnostic({
        severity: "error",
        category: "usage",
        code: "PAVED_AGENT_UNKNOWN",
        component: "cli.commands.agent",
        message: `Unknown agent integration: ${selected ?? operation}.`,
      })],
    });
  }
  const plan = planProjection(agent, invocation.paths.projectRoot, invocation.paths.coreRoot);
  try {
    if (action === "status" || action === "validate") {
      return createResult({
        command: "agent",
        status: "success",
        data: {
          integration: plan.integration,
          files: plan.files.map((file) => file.relativePath),
          valid: true,
        },
      });
    }
    const release = acquireConsumerOperationLock(invocation.paths.projectRoot, `agent:${action}:${agent}`);
    try {
      if (action === "uninstall") {
        return createResult({ command: "agent", status: "success", data: { removed: removeProjection(plan), integration: plan.integration } });
      }
      if (action !== "install" && action !== "update") {
        return createResult({
          command: "agent",
          status: "failed",
          diagnostics: [createDiagnostic({
            severity: "error",
            category: "usage",
            code: "PAVED_AGENT_USAGE",
            component: "cli.commands.agent",
            message: `Unknown agent operation: ${action}.`,
          })],
        });
      }
      return createResult({ command: "agent", status: "success", data: { ...applyProjection(plan), integration: plan.integration } });
    } finally {
      release();
    }
  } catch (error) {
    return createResult({
      command: "agent",
      status: "failed",
      diagnostics: [createDiagnostic({
        severity: "error",
        category: "conflict",
        code: "PAVED_AGENT_OPERATION_FAILED",
        component: "cli.commands.agent",
        message: error instanceof Error ? error.message : "Agent integration operation failed.",
      })],
    });
  }
}
