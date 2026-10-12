import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestFiles, selectE2ETestFiles, selectFastTestFiles } from "./test-profile.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allTests = discoverTestFiles(resolve(root, "tests"));
const profile = process.argv[2] ?? "fast";
let testFiles: string[];
switch (profile) {
  case "fast":
    testFiles = selectFastTestFiles(allTests);
    break;
  case "e2e":
    testFiles = selectE2ETestFiles(allTests);
    break;
  default:
    throw new Error(`Unknown test profile: ${profile}`);
}
if (testFiles.length === 0) {
  throw new Error(`The ${profile} test profile found no test files.`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (result.error) {
  throw result.error;
}
if (result.status === null) {
  throw new Error(`The ${profile} test runner ended unexpectedly (${result.signal ?? "unknown signal"}).`);
}
process.exitCode = result.status;
