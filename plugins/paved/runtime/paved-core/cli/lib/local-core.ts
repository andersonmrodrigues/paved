import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export const LOCAL_CORE_DIGEST_PATHS = ["VERSION", "manifest.yaml", "schemas", "core", "generators", "cli"] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safe(root: string, path: string): string {
  const full = resolve(root, path);
  const resolvedRoot = resolve(root);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes root: ${path}`);
  }
  return full;
}

export function hashLocalFile(root: string, path: string): string {
  return sha256(readFileSync(safe(root, path)));
}

export function hashLocalTree(root: string, paths: readonly string[]): string {
  const entries: string[] = [];

  function collect(path: string): void {
    const full = safe(root, path);
    if (!existsSync(full)) return;
    if (lstatSync(full).isSymbolicLink()) return;
    if (statSync(full).isDirectory()) {
      for (const child of readdirSync(full).sort()) collect(`${path}/${child}`);
      return;
    }
    entries.push(`${path.replace(/\\/g, "/")}\0${hashLocalFile(root, path)}`);
  }

  for (const path of [...paths].sort()) collect(path);
  return sha256(entries.join("\n"));
}

export function hashLocalCore(root: string): string {
  return hashLocalTree(root, LOCAL_CORE_DIGEST_PATHS);
}
