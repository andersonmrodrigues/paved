import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_COMMANDS,
  type AgentCommandContract,
  type DiscoveredAgentCommand,
} from "../../integrations/shared/commands.ts";
import { inspectConsumer, type ConsumerInspection } from "./consumer-state.ts";
import { resolveTestingTool } from "./test-runner.ts";
import { detectCheckCandidates } from "./decisions/providers/verification.ts";

export interface AgentCommandDiscovery {
  readonly lifecycleState: ConsumerInspection["lifecycleState"];
  readonly capabilityProviders: ConsumerInspection["capabilityProviders"];
  readonly commands: readonly DiscoveredAgentCommand[];
}

function availability(
  command: AgentCommandContract,
  inspection: ConsumerInspection,
  projectRoot: string,
  coreRoot: string,
): Pick<DiscoveredAgentCommand, "available" | "reason" | "recommendedNextAction"> {
  if (!command.lifecycle.includes(inspection.lifecycleState)) {
    if (command.name === "init" && inspection.initialized) {
      return { available: false, reason: "Paved is already initialized; init never resets existing state.", recommendedNextAction: "Run /paved:status or /paved:update." };
    }
    return {
      available: false,
      reason: `Command requires lifecycle state ${command.lifecycle.join(" or ")}; current state is ${inspection.lifecycleState}.`,
      recommendedNextAction: inspection.initialized ? "/paved:status" : "/paved:init",
    };
  }
  if (["intent", "plan", "execute"].includes(command.name)) {
    if (inspection.verificationProfile !== "present") {
      if (detectCheckCandidates(projectRoot).length === 0) {
        return { available: false, reason: "An executable workflow needs a verification profile, and no repository check was detected.", recommendedNextAction: "Add a build or test command to the repository, then run /paved:init." };
      }
    }
    const resolution = resolveTestingTool(projectRoot, coreRoot);
    if (resolution.status === "unavailable") {
      return { available: false, reason: resolution.message, recommendedNextAction: resolution.remediation };
    }
  }
  if (command.group === "development" && !inspection.initialized) {
    return { available: false, reason: "Paved is not initialized.", recommendedNextAction: "/paved:init" };
  }
  return { available: true };
}

export function discoverAgentCommands(projectRoot: string, coreRoot: string): AgentCommandDiscovery {
  const inspection = inspectConsumer({ projectRoot, coreRoot });
  const commands = AGENT_COMMANDS.map((command) => {
    if (command.name === "init" && existsSync(join(projectRoot, ".paved"))) {
      return {
        ...command,
        available: false,
        reason: inspection.initialized
          ? "Paved is already initialized; init never resets existing state."
          : "Partial Paved state exists; init will not overwrite or complete it automatically.",
        recommendedNextAction: inspection.initialized ? "/paved:status or /paved:update" : "/paved:status",
      };
    }
    return { ...command, ...availability(command, inspection, projectRoot, coreRoot) };
  });
  return { lifecycleState: inspection.lifecycleState, capabilityProviders: inspection.capabilityProviders, commands };
}
