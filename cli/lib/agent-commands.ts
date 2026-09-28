import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_COMMANDS,
  type AgentCommandContract,
  type DiscoveredAgentCommand,
} from "../../integrations/shared/commands.ts";
import { inspectConsumer, type ConsumerInspection } from "./consumer-state.ts";
import { resolveTestingTool } from "./test-runner.ts";

export interface AgentCommandDiscovery {
  readonly lifecycleState: ConsumerInspection["lifecycleState"];
  readonly capabilityProviders: ConsumerInspection["capabilityProviders"];
  readonly commands: readonly DiscoveredAgentCommand[];
}

function safeFile(root: string, segments: readonly string[], problems: string[]): boolean {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (segment === "" || segment === "." || segment === "..") {
      problems.push(`Refusing unsafe Paved discovery path segment: ${segment}.`);
      return false;
    }
    current = join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        problems.push(`Refusing to follow symbolic link during Paved discovery: ${current}`);
        return false;
      }
      if (index < segments.length - 1 && !entry.isDirectory()) return false;
      if (index === segments.length - 1) return entry.isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

function workflowExists(workflowId: string, projectRoot: string, coreRoot: string, problems: string[]): boolean {
  const [scope, ...segments] = workflowId.split(".");
  if (scope === "core") return safeFile(coreRoot, ["core", "workflows", segments.join("."), "workflow.yaml"], problems);
  if (scope === "project") return safeFile(projectRoot, [".paved", "workflows", ...segments, "workflow.yaml"], problems);
  return false;
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
      recommendedNextAction: inspection.initialized ? "/paved:doctor" : "/paved:init",
    };
  }
  if (command.workflow !== undefined) {
    const pathProblems: string[] = [];
    if (!workflowExists(command.workflow, projectRoot, coreRoot, pathProblems)) {
      return {
        available: false,
        reason: pathProblems[0] ?? `Required workflow "${command.workflow}" is unavailable.`,
        recommendedNextAction: "/paved:doctor",
      };
    }
  }
  if (command.name === "test") {
    const resolution = resolveTestingTool(projectRoot, coreRoot);
    if (resolution.status !== "resolved") {
      return {
        available: false,
        reason: resolution.message,
        recommendedNextAction: resolution.remediation,
      };
    }
  }
  if (["feature", "fix", "refactor", "implement"].includes(command.name)) {
    if (inspection.verificationProfile !== "present") {
      return { available: false, reason: "An executable workflow needs a valid verification profile.", recommendedNextAction: "Configure .paved/verification/profile.yaml with approved checks before starting implementation." };
    }
    const resolution = resolveTestingTool(projectRoot, coreRoot);
    if (resolution.status !== "resolved") {
      return { available: false, reason: resolution.message, recommendedNextAction: resolution.remediation };
    }
  }
  if (command.name === "verify" && inspection.verificationProfile !== "present") {
    return { available: false, reason: "A valid project verification profile is required.", recommendedNextAction: "Configure .paved/verification/profile.yaml, then run /paved:verify." };
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
        recommendedNextAction: inspection.initialized ? "/paved:status or /paved:update" : "/paved:doctor",
      };
    }
    return { ...command, ...availability(command, inspection, projectRoot, coreRoot) };
  });
  return { lifecycleState: inspection.lifecycleState, capabilityProviders: inspection.capabilityProviders, commands };
}
