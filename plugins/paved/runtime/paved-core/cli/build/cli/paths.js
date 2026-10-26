import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
export class CliPathError extends Error {
    path;
    constructor(message, path) {
        super(message);
        this.name = "CliPathError";
        this.path = path;
    }
}
function requireDirectory(path, label) {
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
        throw new CliPathError(`${label} does not exist: ${resolved}`, resolved);
    }
    if (!statSync(resolved).isDirectory()) {
        throw new CliPathError(`${label} is not a directory: ${resolved}`, resolved);
    }
    return resolved;
}
function manifestIn(projectRoot) {
    const manifestPath = join(projectRoot, ".paved/manifest.yaml");
    return existsSync(manifestPath) && statSync(manifestPath).isFile() ? manifestPath : undefined;
}
function nearestAncestorManifest(start) {
    let current = start;
    for (;;) {
        const manifestPath = manifestIn(current);
        if (manifestPath !== undefined) {
            return manifestPath;
        }
        // A consumer nested in a repository must not inherit Paved state from an
        // unrelated directory above that repository (for example a workspace root).
        if (existsSync(join(current, ".git"))) {
            return undefined;
        }
        const parent = dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}
export function resolveProjectRoot(input) {
    if (input.project !== undefined) {
        const projectRoot = requireDirectory(resolve(input.cwd, input.project), "Project path");
        const manifestPath = manifestIn(projectRoot);
        return manifestPath === undefined ? { projectRoot } : { projectRoot, manifestPath };
    }
    const cwd = requireDirectory(input.cwd, "Current working directory");
    const manifestPath = nearestAncestorManifest(cwd);
    if (manifestPath === undefined) {
        return { projectRoot: cwd };
    }
    return {
        projectRoot: dirname(dirname(manifestPath)),
        manifestPath,
    };
}
/**
 * The main worktree's root when `projectRoot` is a linked Git worktree, read from the
 * `.git` file and the worktree's `commondir` the way Git itself resolves them.
 * Undefined for a main worktree, a bare repository or anything unreadable.
 */
export function mainWorktreeRoot(projectRoot) {
    try {
        const dotGit = join(projectRoot, ".git");
        if (!lstatSync(dotGit).isFile())
            return undefined;
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
        if (pointer === undefined)
            return undefined;
        const gitDir = resolve(projectRoot, pointer);
        const commonDir = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
        if (basename(commonDir) !== ".git")
            return undefined;
        const mainRoot = dirname(commonDir);
        return mainRoot === realpathSync(projectRoot) ? undefined : mainRoot;
    }
    catch {
        return undefined;
    }
}
function realExecutablePath(path) {
    const resolved = resolve(path);
    try {
        return realpathSync.native(resolved);
    }
    catch {
        return resolved;
    }
}
export function resolveCoreRoot(input) {
    let current = statSync(realExecutablePath(input.executablePath)).isDirectory()
        ? realExecutablePath(input.executablePath)
        : dirname(realExecutablePath(input.executablePath));
    for (;;) {
        const manifestPath = join(current, "manifest.yaml");
        const packagePath = join(current, "package.json");
        if (existsSync(manifestPath)
            && statSync(manifestPath).isFile()
            && existsSync(packagePath)
            && statSync(packagePath).isFile()) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            throw new CliPathError(`Unable to resolve Paved Core root from executable: ${input.executablePath}`, input.executablePath);
        }
        current = parent;
    }
}
