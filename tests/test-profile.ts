import { readdirSync } from "node:fs";
import { join } from "node:path";

export function discoverTestFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files.sort();
}

export function selectFastTestFiles(files: readonly string[]): string[] {
  return files.filter((file) => !file.endsWith(".e2e.test.ts"));
}

export function selectE2ETestFiles(files: readonly string[]): string[] {
  return files.filter((file) => file.endsWith(".e2e.test.ts"));
}
