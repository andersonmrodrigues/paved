import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function resolveSafePath(root: string, path: string): string {
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
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }

  return fullPath;
}

/**
 * Resolves a path the user names in a consumer: `.paved/` paths live in the state root and
 * every other path in the source root. Both are the project root unless a linked worktree
 * shares the state of its main worktree. The path may not escape the root it resolves in.
 */
export function resolveConsumerPath(stateRoot: string, sourceRoot: string, path: string): string {
  if (isAbsolute(path)) {
    const inside = (root: string): boolean => {
      const rel = relative(realpathSync(root), resolve(path));
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    return resolveSafePath(inside(sourceRoot) || !inside(stateRoot) ? sourceRoot : stateRoot, path);
  }
  const normalized = path.split(sep).join("/").replace(/^(\.\/)+/, "");
  return resolveSafePath(normalized === ".paved" || normalized.startsWith(".paved/") ? stateRoot : sourceRoot, path);
}
