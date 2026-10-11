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
