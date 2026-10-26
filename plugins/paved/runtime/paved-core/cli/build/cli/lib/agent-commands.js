import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_COMMANDS, } from "../../integrations/shared/commands.js";
import { inspectConsumer } from "./consumer-state.js";
import { resolveTestingTool } from "./test-runner.js";
import { detectCheckCandidates } from "./decisions/providers/verification.js";
function availability(command, inspection, projectRoot, sourceRoot, coreRoot) {
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
    // execute starts by initializing Paved, which detects the checks and the testing Tool.
    if (command.name === "execute" && !inspection.initialized)
        return { available: true };
    if (["intent", "plan", "execute"].includes(command.name)) {
        if (inspection.verificationProfile !== "present") {
            if (detectCheckCandidates(sourceRoot).length === 0) {
                return { available: false, reason: "An executable workflow needs a verification profile, and no repository check was detected.", recommendedNextAction: "Add a build or test command to the repository, then run /paved:init." };
            }
        }
        const resolution = resolveTestingTool(projectRoot, coreRoot, sourceRoot);
        if (resolution.status === "unavailable") {
            return { available: false, reason: resolution.message, recommendedNextAction: resolution.remediation };
        }
    }
    if (command.group === "development" && !inspection.initialized) {
        return { available: false, reason: "Paved is not initialized.", recommendedNextAction: "/paved:init" };
    }
    return { available: true };
}
export function discoverAgentCommands(projectRoot, coreRoot, sourceRoot = projectRoot) {
    const inspection = inspectConsumer({ projectRoot, sourceRoot, coreRoot });
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
        return { ...command, ...availability(command, inspection, projectRoot, sourceRoot, coreRoot) };
    });
    return { lifecycleState: inspection.lifecycleState, capabilityProviders: inspection.capabilityProviders, commands };
}
