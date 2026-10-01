import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
function readSelection(projectRoot) {
    const path = join(projectRoot, ".paved/runtime/selection.json");
    if (!existsSync(path))
        return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw.package !== "paved-core"
        || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)
        || typeof raw.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(raw.integrity)
        || typeof raw.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.content_sha256)) {
        throw new Error("Invalid .paved/runtime/selection.json; restore a verified runtime selection.");
    }
    return {
        runtime: { package: "paved-core", version: raw.version, integrity: raw.integrity, content_sha256: raw.content_sha256 },
        directory: raw.directory,
    };
}
/** The launcher validates the full installation; the Core records its immutable selection. */
export function readRuntimeSelection(projectRoot) {
    return readSelection(projectRoot)?.runtime;
}
/**
 * The selection the launcher verified and activated, when this Core is executing from it.
 * Only then may an update move the lock to a runtime that differs from the pinned one.
 */
export function readActiveRuntimeSelection(projectRoot, coreRoot) {
    const selection = readSelection(projectRoot);
    if (selection === undefined || typeof selection.directory !== "string" || !/^[a-zA-Z0-9.-]+$/.test(selection.directory))
        return undefined;
    const installed = join(projectRoot, ".paved/runtime/versions", selection.directory, "node_modules", "paved-core");
    try {
        return realpathSync(installed) === realpathSync(coreRoot) ? selection.runtime : undefined;
    }
    catch {
        return undefined;
    }
}
