import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeLock {
  readonly package: "paved-core";
  readonly version: string;
  readonly integrity: string;
  readonly content_sha256: string;
}

/** The launcher validates the full installation; the Core records its immutable selection. */
export function readRuntimeSelection(projectRoot: string): RuntimeLock | undefined {
  const path = join(projectRoot, ".paved/runtime/selection.json");
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw.package !== "paved-core"
    || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)
    || typeof raw.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(raw.integrity)
    || typeof raw.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.content_sha256)) {
    throw new Error("Invalid .paved/runtime/selection.json; restore a verified runtime selection.");
  }
  return { package: "paved-core", version: raw.version, integrity: raw.integrity, content_sha256: raw.content_sha256 };
}
