import { hasContextDrift } from "./consumer-state.js";
/**
 * Initialization and compatible updates are safe to run on the user's behalf: they raise
 * their own decisions when something needs a choice. A BROKEN project needs a human.
 */
export function remediationFor(lifecycle) {
    if (lifecycle === "UNINITIALIZED")
        return { command: "paved init --json", reason: "Paved is not initialized in this repository." };
    if (lifecycle === "INITIALIZED" || lifecycle === "STALE" || lifecycle === "INCOMPATIBLE") {
        return { command: "paved update --json", reason: `The project is ${lifecycle}; an update resolves it.` };
    }
    return undefined;
}
/**
 * Like remediationFor, but also offers to regenerate project context whose cited sources
 * changed. That drift never blocks work; refreshing it is still worthwhile.
 */
export function refreshFor(inspection) {
    return remediationFor(inspection.lifecycleState) ?? (hasContextDrift(inspection)
        ? { command: "paved update --json", reason: "Generated project context cites source files that changed; an update regenerates it." }
        : undefined);
}
