import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDiagnostic } from "../result.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { resolveSafePath } from "./safe-path.js";
const AGENTS_PATH = "AGENTS.md";
const BEGIN = "<!-- paved:begin managed -->";
const END = "<!-- paved:end managed -->";
function managedBlock(coreRoot) {
    return readFileSync(join(coreRoot, "core/templates/AGENTS.md"), "utf8").trimEnd();
}
const MISSING_END = "AGENTS.md has a Paved begin marker without an end marker.";
export function inspectAgentsBlock(coreRoot, projectRoot) {
    let current;
    try {
        const path = resolveSafePath(projectRoot, AGENTS_PATH);
        if (!existsSync(path))
            return { state: "absent" };
        current = readFileSync(path, "utf8");
    }
    catch (error) {
        return { state: "invalid", reason: `AGENTS.md cannot be read safely: ${error instanceof Error ? error.message : String(error)}` };
    }
    const begin = current.indexOf(BEGIN);
    if (begin === -1)
        return { state: "absent" };
    const end = current.indexOf(END, begin);
    if (end === -1)
        return { state: "invalid", reason: MISSING_END };
    return { state: current.slice(begin, end + END.length) === managedBlock(coreRoot) ? "current" : "outdated" };
}
/** Rewrites an existing managed block to the current template; never creates one. */
export function refreshAgentsBlock(coreRoot, projectRoot) {
    const inspection = inspectAgentsBlock(coreRoot, projectRoot);
    if (inspection.state === "invalid")
        return { status: "invalid", reason: inspection.reason };
    if (inspection.state !== "outdated")
        return { status: "unchanged" };
    try {
        return ensureAgentsBlock(coreRoot, projectRoot);
    }
    catch (error) {
        return { status: "invalid", reason: `AGENTS.md could not be rewritten: ${error instanceof Error ? error.message : String(error)}` };
    }
}
export function agentsBlockInvalidDiagnostic(reason) {
    return createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_AGENTS_BLOCK_INVALID", component: "consumer.agents", message: reason,
        remediation: "Make AGENTS.md a regular file in the repository with matching Paved begin and end markers, then run paved update.",
    });
}
/**
 * Maintains the delimited Paved block in the root AGENTS.md: creates the file when it is
 * missing, appends the block when absent and replaces only the block when present.
 * Text outside the block is never changed.
 */
export function ensureAgentsBlock(coreRoot, projectRoot) {
    const block = managedBlock(coreRoot);
    const path = resolveSafePath(projectRoot, AGENTS_PATH);
    const exists = existsSync(path);
    const current = exists ? readFileSync(path, "utf8") : "";
    const begin = current.indexOf(BEGIN);
    const end = begin === -1 ? -1 : current.indexOf(END, begin);
    if (begin !== -1 && end === -1) {
        return { status: "invalid", reason: MISSING_END };
    }
    const next = begin !== -1
        ? `${current.slice(0, begin)}${block}${current.slice(end + END.length)}`
        : current.trim() === "" ? `${block}\n` : `${current.trimEnd()}\n\n${block}\n`;
    if (next === current)
        return { status: "unchanged" };
    atomicWriteFileSync(path, next);
    return { status: exists ? "updated" : "created" };
}
