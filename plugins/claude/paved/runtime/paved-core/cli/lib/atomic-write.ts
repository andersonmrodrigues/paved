import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function atomicWriteFileSync(path: string, content: string | Uint8Array): void {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    let mode: number | undefined;
    try {
      const existing = lstatSync(path);
      if (existing.isFile()) mode = existing.mode & 0o777;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    writeFileSync(temporaryPath, content, { flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}
