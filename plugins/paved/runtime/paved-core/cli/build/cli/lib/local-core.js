import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
export const LOCAL_CORE_DIGEST_PATHS = ["VERSION", "manifest.yaml", "schemas", "core", "generators", "cli"];
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function safe(root, path) {
    const full = resolve(root, path);
    const resolvedRoot = resolve(root);
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) {
        throw new Error(`Path escapes root: ${path}`);
    }
    return full;
}
export function hashLocalFile(root, path) {
    return sha256(readFileSync(safe(root, path)));
}
export function hashLocalTree(root, paths) {
    const entries = [];
    function collect(path) {
        const full = safe(root, path);
        if (!existsSync(full))
            return;
        if (lstatSync(full).isSymbolicLink())
            return;
        if (statSync(full).isDirectory()) {
            for (const child of readdirSync(full).sort())
                collect(`${path}/${child}`);
            return;
        }
        entries.push(`${path.replace(/\\/g, "/")}\0${hashLocalFile(root, path)}`);
    }
    for (const path of [...paths].sort())
        collect(path);
    return sha256(entries.join("\n"));
}
export function hashLocalCore(root) {
    return hashLocalTree(root, LOCAL_CORE_DIGEST_PATHS);
}
