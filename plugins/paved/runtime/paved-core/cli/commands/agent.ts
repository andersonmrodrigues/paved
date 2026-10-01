import { createDiagnostic, createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { acquireConsumerOperationLock } from "../lib/operation-lock.ts";
import { applyProjection, planProjection, removeProjection } from "../../integrations/shared/projection.ts";
import { AGENT_COMMANDS } from "../../integrations/shared/commands.ts";
import { discoverAgentCommands } from "../lib/agent-commands.ts";
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
  if (operation === "commands" || operation === "discover") {
    if (invocation.selectors.length > 2) {
      return createResult({
        command: "agent",
        status: "failed",
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "usage",
          code: "PAVED_AGENT_USAGE",
          component: "cli.commands.agent",
          message: `${operation} accepts at most one optional agent integration.`,
          remediation: "Use paved agent commands [codex|claude-code] --json.",
        })],
      });
    }
    if (selected !== undefined && agentId(selected) === undefined) {
      return createResult({
        command: "agent",
        status: "failed",
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "usage",
          code: "PAVED_AGENT_UNKNOWN",
          component: "cli.commands.agent",
          message: `Unknown agent integration: ${selected}.`,
          remediation: "Choose codex or claude-code, or omit the integration to inspect the shared command contract.",
        })],
      });
    }
    const discovery = discoverAgentCommands(invocation.paths.projectRoot, invocation.paths.coreRoot);
    return createResult({
      command: "agent",
      status: "success",
      data: {
        sourceOfTruth: ".paved/",
        lifecycleState: discovery.lifecycleState,
        ...(selected === undefined ? {} : { integration: selected }),
        capabilityProviders: discovery.capabilityProviders,
        commands: discovery.commands,
      },
    });
  }
  if (operation === "command") {
    if (invocation.selectors.length !== 2) {
      return createResult({
        command: "agent",
        status: "failed",
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "usage",
          code: "PAVED_AGENT_USAGE",
          component: "cli.commands.agent",
          message: "Command resolution accepts exactly one Paved command name.",
          remediation: "Use paved agent command <name> --json.",
        })],
      });
    }
    const contract = AGENT_COMMANDS.find((command) => command.name === selected || command.id === selected);
    if (selected === undefined || contract === undefined) {
      return createResult({
        command: "agent",
        status: "failed",
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "usage",
          code: "PAVED_AGENT_COMMAND_UNKNOWN",
          component: "cli.commands.agent",
          message: selected === undefined ? "Missing Paved command name." : `Unknown Paved command: ${selected}.`,
          remediation: `Choose one of: ${AGENT_COMMANDS.map((command) => command.name).join(", ")}.`,
        })],
      });
    }
    const discovery = discoverAgentCommands(invocation.paths.projectRoot, invocation.paths.coreRoot);
    const discovered = discovery.commands.find((command) => command.id === contract.id)!;
    if (!discovered.available) {
      return createResult({
        command: "agent",
        status: "failed",
        data: { command: discovered, lifecycleState: discovery.lifecycleState },
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "config",
          code: "PAVED_AGENT_COMMAND_UNAVAILABLE",
          component: "cli.commands.agent",
          message: discovered.reason ?? `Paved command ${selected} is unavailable.`,
          remediation: discovered.recommendedNextAction ?? "Run paved agent commands --json to inspect command availability.",
        })],
      });
    }
    return createResult({
      command: "agent",
      status: "success",
      data: {
        invocation: "agent-orchestrated",
        command: discovered,
        lifecycleState: discovery.lifecycleState,
        sourceOfTruth: ".paved/",
        workflow: discovered.workflow,
        tool: discovered.tool,
      },
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
