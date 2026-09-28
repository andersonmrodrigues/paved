import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProjectRootInput {
  readonly cwd: string;
  readonly project?: string;
}

export interface ProjectRootResolution {
  readonly projectRoot: string;
  readonly manifestPath?: string;
}

export interface CoreRootInput {
  readonly executablePath: string;
}

export class CliPathError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "CliPathError";
    this.path = path;
  }
}

function requireDirectory(path: string, label: string): string {
  const resolved = resolve(path);

  if (!existsSync(resolved)) {
    throw new CliPathError(`${label} does not exist: ${resolved}`, resolved);
  }

  if (!statSync(resolved).isDirectory()) {
    throw new CliPathError(`${label} is not a directory: ${resolved}`, resolved);
  }

  return resolved;
}

function manifestIn(projectRoot: string): string | undefined {
  const manifestPath = join(projectRoot, ".paved/manifest.yaml");
  return existsSync(manifestPath) && statSync(manifestPath).isFile() ? manifestPath : undefined;
}

function nearestAncestorManifest(start: string): string | undefined {
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

export function resolveProjectRoot(input: ProjectRootInput): ProjectRootResolution {
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

function realExecutablePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveCoreRoot(input: CoreRootInput): string {
  let current = statSync(realExecutablePath(input.executablePath)).isDirectory()
    ? realExecutablePath(input.executablePath)
    : dirname(realExecutablePath(input.executablePath));

  for (;;) {
    const manifestPath = join(current, "manifest.yaml");
    const packagePath = join(current, "package.json");

    if (
      existsSync(manifestPath)
      && statSync(manifestPath).isFile()
      && existsSync(packagePath)
      && statSync(packagePath).isFile()
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new CliPathError(`Unable to resolve Paved Core root from executable: ${input.executablePath}`, input.executablePath);
    }
    current = parent;
  }
}
