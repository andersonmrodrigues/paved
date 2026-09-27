import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadYaml } from "../cli/lib/documents.ts";
import { createRegistry, type SchemaRegistry } from "../cli/lib/schemas.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const temporaryDirectories = new Set<string>();

export function temporaryDirectory(prefix = "paved-test", parent = tmpdir()): string {
  mkdirSync(parent, { recursive: true });
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "paved-test";
  const path = join(parent, `${safePrefix}-${randomUUID()}`);
  mkdirSync(path);
  temporaryDirectories.add(path);
  return path;
}

export function temporaryFixture(source: string, prefix = "paved-fixture", parent?: string): string {
  const path = temporaryDirectory(prefix, parent);
  cpSync(source, path, { recursive: true });
  return path;
}

export function cleanupTemporaryDirectories(): void {
  for (const path of temporaryDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
}

export const at = (...segments: string[]): string => join(ROOT, ...segments);

let registry: SchemaRegistry | undefined;

export function schemas(): SchemaRegistry {
  registry ??= createRegistry(at("schemas"), coreManifest().supported_api_versions);
  return registry;
}

export function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

export function filesRecursive(dir: string, predicate: (file: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      if (name === "node_modules" || name === ".git") {
        continue;
      }
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return out;
}

export const rel = (file: string): string => relative(ROOT, file);

export interface LayoutEntry {
  path: string;
  ownership: string;
  required: boolean;
  schema?: string;
}

export interface Component {
  name: string;
  path: string;
  distributed: boolean;
  depends_on: string[];
}

export interface CoreManifest {
  version: string;
  schemas: Record<string, string>;
  context_areas: Record<string, string>;
  content: Record<string, string>;
  consumer_layout: LayoutEntry[];
  components: Component[];
  supported_api_versions: string[];
  schema_definitions: string[];
}

export function coreManifest(): CoreManifest {
  return loadYaml(at("manifest.yaml")) as CoreManifest;
}

/** The layout entry that governs a consumer path: the longest match wins. */
export function layoutEntryOf(path: string, layout: LayoutEntry[]): LayoutEntry | undefined {
  const matches = layout.filter((entry) =>
    entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path,
  );
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches[0];
}

export const ownershipOf = (path: string, layout: LayoutEntry[]): string | undefined =>
  layoutEntryOf(path, layout)?.ownership;

export function formatErrors(file: string, errors: string[]): string {
  return `${file}:\n  ${errors.join("\n  ")}`;
}
