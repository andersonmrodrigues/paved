import { listDecisions } from "./store.js";
/** Capability and scope to provider, from applied material decisions only. */
export function answeredProviders(projectRoot, coreRoot, records) {
    const answers = new Map();
    for (const decision of records ?? listDecisions(projectRoot, coreRoot)) {
        if (decision.status !== "APPLIED" || decision.handler !== "capability.select")
            continue;
        const marker = decision.fingerprint.inputs.find((item) => item.startsWith("candidate:capability:"));
        const key = marker?.slice("candidate:capability:".length);
        if (key === undefined || typeof decision.answer !== "string")
            continue;
        const option = decision.options.find((item) => item.id === decision.answer);
        if (option === undefined)
            continue;
        const separator = key.lastIndexOf("@");
        if (separator <= 0)
            continue;
        const capability = key.slice(0, separator);
        const scope = key.slice(separator + 1);
        answers.set(scope === "." ? capability : `${capability}@${scope}`, option.label);
    }
    return answers;
}
