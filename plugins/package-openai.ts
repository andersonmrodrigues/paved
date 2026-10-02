// Packs plugins/paved/ as the ZIP that OpenAI's plugin directory accepts: the Codex plugin
// without lifecycle hooks, which submitted plugins may not carry, and without the Cursor
// manifest. The result goes to dist/ and is never committed.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_DIRECTORY, readPluginSource } from "./build.ts";

export const OPENAI_EXCLUDED = ["hooks/*", ".cursor-plugin/*"];

export function packageOpenAI(root: string): string {
  const source = readPluginSource(root);
  const output = join(root, "dist", `${source.name}-openai-${source.version}.zip`);
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const zipped = spawnSync("zip", ["-X", "-q", "-r", output, ".", "-x", ...OPENAI_EXCLUDED], { cwd: join(root, PLUGIN_DIRECTORY), encoding: "utf8", shell: false });
  if (zipped.error !== undefined || zipped.status !== 0) throw new Error(`zip failed: ${zipped.stderr || zipped.error?.message}`);
  return output;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${packageOpenAI(resolve(dirname(fileURLToPath(import.meta.url)), ".."))}\n`);
}
