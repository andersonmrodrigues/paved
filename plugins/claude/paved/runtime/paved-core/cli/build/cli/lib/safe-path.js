import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
function isMissingPath(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function resolveSafePath(root, path) {
    const resolvedRoot = realpathSync(root);
    const fullPath = resolve(resolvedRoot, path);
    const relativePath = relative(resolvedRoot, fullPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`Path escapes repository: ${path}`);
    }
    let current = resolvedRoot;
    for (const component of relativePath.split(sep).filter(Boolean)) {
        current = join(current, component);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error(`Path traverses a symbolic link: ${path}`);
            }
        }
        catch (error) {
            if (!isMissingPath(error))
                throw error;
        }
    }
    return fullPath;
}
