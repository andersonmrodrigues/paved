import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasContextDrift, inspectConsumer } from "./consumer-state.js";
import { compareCoreVersions, isCoreVersion } from "./runtime-lock.js";
import { loadMarkdown, loadYaml } from "./documents.js";
import { resolveSafePath } from "./safe-path.js";
/** Checks that recorded project outputs are still eligible for the existing provenance scan. */
function hasGenerationEvidence(projectRoot) {
    try {
        const record = JSON.parse(readFileSync(join(projectRoot, ".paved/generated/state/last-run.json"), "utf8"));
        if (!Array.isArray(record.executions))
            return false;
        let checked = 0;
        for (const entry of record.executions) {
            if (entry === null || typeof entry !== "object")
                return false;
            const execution = entry;
            if (execution.status === "failed")
                return false;
            if (!Array.isArray(execution.outputs))
                return false;
            for (const output of execution.outputs) {
                if (typeof output !== "string")
                    return false;
                if (!output.startsWith(".paved/project/"))
                    continue;
                if (typeof execution.generator !== "string" || !Array.isArray(execution.sources))
                    return false;
                const path = resolveSafePath(projectRoot, output);
                const document = output.endsWith(".md") ? loadMarkdown(path).frontmatter
                    : /\.ya?ml$/.test(output) ? loadYaml(path) : undefined;
                if (document === null || typeof document !== "object")
                    return false;
                const provenance = document.provenance;
                if (provenance?.generator !== execution.generator || !Array.isArray(provenance.sources))
                    return false;
                checked++;
            }
        }
        return checked > 0;
    }
    catch {
        return false;
    }
}
/** Read-only diagnosis using the same lifecycle and provenance scan as status. */
export function diagnoseQuick(input) {
    const inspection = inspectConsumer(input);
    const diagnostics = inspection.diagnostics.map(({ remediation: _remediation, ...finding }) => finding);
    const pinned = inspection.core.lockedVersion;
    const launcher = input.launcherCoreVersion;
    const updateCheck = launcher === undefined ? "unavailable"
        : !isCoreVersion(launcher) ? "invalid"
            : pinned === undefined || !isCoreVersion(pinned) ? "unavailable"
                : compareCoreVersions(launcher, pinned) > 0 ? "available" : "current";
    const update = updateCheck === "available" && pinned !== undefined && launcher !== undefined
        ? { pinnedVersion: pinned, availableVersion: launcher } : undefined;
    const drift = hasContextDrift(inspection);
    const context = drift ? "stale" : hasGenerationEvidence(input.projectRoot) ? "no-drift-detected" : "unavailable";
    let status;
    if (!inspection.initialized) {
        status = existsSync(join(input.projectRoot, ".paved")) ? "broken" : "uninitialized";
    }
    else if (inspection.lifecycleState === "BROKEN")
        status = "broken";
    else if (inspection.diagnostics.some((item) => item.category === "conflict") || inspection.conflicts.length > 0 || inspection.proposals.length > 0)
        status = "conflict";
    else if (inspection.lifecycleState === "INCOMPATIBLE")
        status = "incompatible";
    else if (inspection.lifecycleState === "STALE")
        status = "stale";
    else if (inspection.diagnostics.some((item) => item.category !== "findings"))
        status = "broken";
    else if (updateCheck === "available")
        status = "outdated";
    else if (drift)
        status = "stale-context";
    else if (context === "unavailable" || updateCheck !== "current" || inspection.lockHealth !== "healthy")
        status = "unknown";
    else
        status = "healthy";
    return { status, context, staleGenerators: inspection.staleGenerators ?? [], updateCheck,
        ...(update === undefined ? {} : { update }), diagnostics };
}
