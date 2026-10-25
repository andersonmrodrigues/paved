import { hasContextDrift, type ConsumerInspection } from "./consumer-state.ts";

/** A Paved command that brings the project back to a workable lifecycle state without a human decision of its own. */
export interface Remediation {
  readonly command: string;
  readonly reason: string;
}

/**
 * Initialization and compatible updates are safe to run on the user's behalf: they raise
 * their own decisions when something needs a choice. A BROKEN project needs a human.
 */
export function remediationFor(lifecycle: string): Remediation | undefined {
  if (lifecycle === "UNINITIALIZED") return { command: "paved init --json", reason: "Paved is not initialized in this repository." };
  if (lifecycle === "INITIALIZED" || lifecycle === "STALE" || lifecycle === "INCOMPATIBLE") {
    return { command: "paved update --json", reason: `The project is ${lifecycle}; an update resolves it.` };
  }
  return undefined;
}

/**
 * Like remediationFor, but also offers to regenerate project context whose cited sources
 * changed. That drift never blocks work; refreshing it is still worthwhile.
 */
export function refreshFor(inspection: Pick<ConsumerInspection, "lifecycleState" | "diagnostics">): Remediation | undefined {
  return remediationFor(inspection.lifecycleState) ?? (hasContextDrift(inspection)
    ? { command: "paved update --json", reason: "Generated project context cites source files that changed; an update regenerates it." }
    : undefined);
}
