import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

async function run(project: string, ...args: string[]) {
  return dispatchCli({ argv: ["task", ...args, "--project", project], cwd: ROOT, executablePath: join(ROOT, "cli/index.ts") });
}

it("starts, notes, resumes and completes a task without losing its notes", async () => {
  const project = temporaryDirectory("paved-task-command");
  mkdirSync(join(project, ".paved"));
  writeFileSync(join(project, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\n");
  assert.equal((await run(project, "start", "example", "The goal")).status, "success");
  assert.equal((await run(project, "note", "example", "A change in scope")).status, "success");
  const resumed = await run(project, "resume", "example");
  assert.equal(resumed.status, "success");
  assert.match(JSON.stringify(resumed.data), /A change in scope/);
  assert.equal((await run(project, "done", "example", "Finished")).status, "success");
  const content = readFileSync(join(project, ".paved/tasks/example.md"), "utf8");
  assert.match(content, /Status: done/);
  assert.match(content, /A change in scope/);
  assert.equal((await run(project, "start", "example", "Replace")).status, "failed");
  assert.equal(readFileSync(join(project, ".paved/tasks/example.md"), "utf8"), content);
});

it("does not create state in an uninitialized project", async () => {
  const project = temporaryDirectory("paved-task-uninitialized");
  assert.equal((await run(project, "start", "example", "Goal")).status, "failed");
  assert.equal(existsSync(join(project, ".paved")), false);
});

it("rejects malformed operations without modifying the task", async () => {
  const project = temporaryDirectory("paved-task-usage");
  mkdirSync(join(project, ".paved"));
  writeFileSync(join(project, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\n");
  for (const args of [["start", "example"], ["resume", "example", "extra"], ["unknown", "example"]]) {
    assert.equal((await run(project, ...args)).status, "failed");
  }
  assert.equal(existsSync(join(project, ".paved/tasks")), false);
});
