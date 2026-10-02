import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { resolveSafePath } from "./safe-path.js";
const AGENTS_PATH = "AGENTS.md";
const BEGIN = "<!-- paved:begin managed -->";
const END = "<!-- paved:end managed -->";
/**
 * Maintains the delimited Paved block in the root AGENTS.md: creates the file when it is
 * missing, appends the block when absent and replaces only the block when present.
 * Text outside the block is never changed.
 */
export function ensureAgentsBlock(coreRoot, projectRoot) {
    const block = readFileSync(join(coreRoot, "core/templates/AGENTS.md"), "utf8").trimEnd();
    const path = resolveSafePath(projectRoot, AGENTS_PATH);
    const exists = existsSync(path);
    const current = exists ? readFileSync(path, "utf8") : "";
    const begin = current.indexOf(BEGIN);
    const end = begin === -1 ? -1 : current.indexOf(END, begin);
    if (begin !== -1 && end === -1) {
        return { status: "invalid", reason: "AGENTS.md has a Paved begin marker without an end marker." };
    }
    const next = begin !== -1
        ? `${current.slice(0, begin)}${block}${current.slice(end + END.length)}`
        : current.trim() === "" ? `${block}\n` : `${current.trimEnd()}\n\n${block}\n`;
    if (next === current)
        return { status: "unchanged" };
    atomicWriteFileSync(path, next);
    return { status: exists ? "updated" : "created" };
}
