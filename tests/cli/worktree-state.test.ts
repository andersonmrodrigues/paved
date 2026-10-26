import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { loadYaml } from "../../cli/lib/documents.ts";
import { resolveConsumerPath } from "../../cli/lib/safe-path.ts";
import { isCheckoutOf, mainWorktreeRoot, resolveProjectRoot } from "../../cli/paths.ts";
import { exitCode, type CommandResult } from "../../cli/result.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const core = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const cli = (cwd: string, ...argv: string[]): Promise<CommandResult> =>
  dispatchCli({ argv: [...argv, "--json"], cwd, executablePath: join(core, "cli/index.ts") });

const codes = (result: CommandResult): string[] => result.diagnostics.map((item) => item.code);

/**
 * A committed consumer whose `.paved/` stays untracked, so only the main worktree has it,
 * and a linked worktree whose source differs: its tests pass where the main worktree's fail.
 */
async function repository(): Promise<{ main: string; linked: string }> {
  const main = join(temporaryDirectory("paved-worktree-main"), "consumer");
  mkdirSync(join(main, "src"), { recursive: true });
  writeFileSync(join(main, "README.md"), "# Consumer\n");
  writeFileSync(join(main, "src/feature.js"), "export const ready = false;\n");
  writeFileSync(join(main, "check.mjs"),
    'import { readFileSync } from "node:fs";\nprocess.exitCode = readFileSync("src/feature.js", "utf8").includes("true") ? 0 : 1;\n');
  writeFileSync(join(main, ".gitignore"), ".paved/\n");
  git(main, "init", "-q");
  git(main, "add", ".");
  git(main, "commit", "-qm", "base");
  const init = await cli(main, "init", "--no-generate");
  assert.equal(init.status, "success", JSON.stringify(init.diagnostics));
  const tool = { ...structuredClone(loadYaml(join(core, "core/tools/testing/run.yaml")) as Record<string, unknown>), id: "project.testing.run" };
  mkdirSync(join(main, ".paved/tools"), { recursive: true });
  mkdirSync(join(main, ".paved/tool-implementations"), { recursive: true });
  writeFileSync(join(main, ".paved/tools/testing-run.yaml"), stringify(tool));
  writeFileSync(join(main, ".paved/tool-implementations/testing-run.yaml"), stringify({
    apiVersion: "paved/v1", kind: "ToolImplementation", id: "project.testing.run", tool: "project.testing.run",
    version: "1.0.0", contract: "^0.1.0", source: "project", environments: ["local"],
    invocation: { type: "command", executable: "node", arguments: ["--", "check.mjs"] }, availability: "available",
  }));
  const linked = join(temporaryDirectory("paved-worktree-linked"), "feature");
  git(main, "worktree", "add", "-q", "-b", "feature", linked);
  writeFileSync(join(linked, "src/feature.js"), "export const ready = true;\n");
  return { main, linked };
}

interface StatusData {
  projectRoot: string; stateRoot?: string; sourceRoot?: string; contextWorktrees?: string[];
  initialized: boolean; actionableFindings: { code: string }[];
}

test("a normal checkout keeps a single root and its own source", async () => {
  const { main, linked } = await repository();
  assert.deepEqual(resolveProjectRoot({ cwd: main }), { projectRoot: main, manifestPath: join(main, ".paved/manifest.yaml") });
  assert.equal(isCheckoutOf(main, main), true);

  const status = await cli(main, "status");
  const data = status.data as StatusData;
  assert.equal(data.projectRoot, main);
  assert.equal(data.stateRoot, undefined);
  assert.equal(data.sourceRoot, undefined);
  assert.ok(!codes(status).includes("PAVED_WORKTREE_STATE_IN_MAIN"), JSON.stringify(status.diagnostics));

  const tested = await cli(main, "test");
  assert.equal(tested.status, "failed", "the main worktree's own source still fails its tests");
  const generated = await cli(main, "generate");
  assert.notEqual(generated.status, "failed", JSON.stringify(generated.diagnostics));
  const lastRun = JSON.parse(readFileSync(join(main, ".paved/generated/state/last-run.json"), "utf8")) as { executions: Record<string, unknown>[] };
  assert.ok(lastRun.executions.every((execution) => !("sourceWorktree" in execution)));
  // A linked worktree's different source never makes the main worktree's context drift.
  writeFileSync(join(linked, "README.md"), "# Changed only in the linked worktree\n");
  assert.ok(!codes(await cli(main, "status")).includes("PAVED_GENERATED_SOURCE_STALE"));
});

test("a linked worktree uses the main worktree's state and its own source for tests and digests", async () => {
  const { main, linked } = await repository();
  const resolved = resolveProjectRoot({ cwd: join(linked, "src") });
  assert.equal(resolved.projectRoot, realpathSync(main));
  assert.equal(resolved.sourceRoot, linked);

  const status = await cli(linked, "status");
  const data = status.data as StatusData;
  assert.equal(data.initialized, true);
  assert.equal(data.stateRoot, realpathSync(main));
  assert.equal(data.sourceRoot, linked);
  const shared = status.diagnostics.find((item) => item.code === "PAVED_WORKTREE_STATE_IN_MAIN");
  assert.equal(shared?.severity, "info", JSON.stringify(status.diagnostics));
  assert.ok(!data.actionableFindings.some((item) => item.code === "PAVED_WORKTREE_STATE_IN_MAIN"));

  const tested = await cli(linked, "test");
  assert.equal(tested.status, "success", JSON.stringify(tested.diagnostics));
  const evidence = (tested.data as { evidence: string }).evidence;
  assert.equal(existsSync(join(main, evidence)), true, "evidence is shared state");
  assert.equal(existsSync(join(linked, ".paved")), false, "the linked worktree gains no state of its own");
  assert.equal((await cli(main, "test")).status, "failed");

  const generated = await cli(linked, "generate");
  assert.notEqual(generated.status, "failed", JSON.stringify(generated.diagnostics));
  const lastRun = JSON.parse(readFileSync(join(main, ".paved/generated/state/last-run.json"), "utf8")) as { executions: { sourceWorktree?: string }[] };
  assert.ok(lastRun.executions.length > 0 && lastRun.executions.every((execution) => execution.sourceWorktree === linked));
  assert.deepEqual(((await cli(main, "status")).data as StatusData).contextWorktrees, [linked]);

  // The context describes the linked worktree: a change in the main worktree is not drift.
  writeFileSync(join(main, "README.md"), "# Changed only in the main worktree\n");
  assert.ok(!codes(await cli(main, "status")).includes("PAVED_GENERATED_SOURCE_STALE"));
  assert.ok(!codes(await cli(linked, "status")).includes("PAVED_GENERATED_SOURCE_STALE"));
  writeFileSync(join(linked, "README.md"), "# Changed in the linked worktree\n");
  assert.ok(codes(await cli(main, "status")).includes("PAVED_GENERATED_SOURCE_STALE"));
  assert.ok(codes(await cli(linked, "status")).includes("PAVED_GENERATED_SOURCE_STALE"));
});

test("a run started in one worktree is refused from another", async () => {
  const { main, linked } = await repository();
  const request = ["intent", "Make the feature ready", "--workflow", "feature", "--because", "Requested."];
  const started = await cli(linked, ...request);
  assert.notEqual(started.status, "failed", JSON.stringify(started.diagnostics));
  const id = (started.data as { run: string }).run;
  const run = parse(readFileSync(join(main, `.paved/generated/runs/${id}.yaml`), "utf8")) as { worktree?: string };
  assert.equal(run.worktree, linked);

  const resumed = await cli(main, "plan", "--run", id);
  assert.equal(resumed.status, "failed");
  assert.deepEqual(codes(resumed), ["PAVED_WORKFLOW_WORKTREE_MISMATCH"]);
  assert.ok(resumed.diagnostics[0]!.remediation?.includes(linked), resumed.diagnostics[0]!.remediation);
  assert.equal(exitCode(resumed), exitCode((await cli(main, "plan", "--run", "intent-does-not-exist"))));

  const selected = await cli(main, "plan");
  assert.deepEqual(codes(selected), ["PAVED_WORKFLOW_RUN_REQUIRED"]);
  assert.ok(selected.diagnostics[0]!.message.includes(id), selected.diagnostics[0]!.message);
  assert.ok(!codes(await cli(linked, "plan", "--run", id)).includes("PAVED_WORKFLOW_WORKTREE_MISMATCH"));

  // The same request in the main worktree starts its own run instead of joining the linked one.
  const own = await cli(main, ...request);
  assert.notEqual(own.status, "failed", JSON.stringify(own.diagnostics));
  assert.notEqual((own.data as { run: string }).run, id);
});

test("a worktree with its own .paved/ keeps using it while other worktrees share the main state", async () => {
  const { main, linked } = await repository();
  const committed = join(temporaryDirectory("paved-worktree-own"), "own");
  git(main, "worktree", "add", "-q", "-b", "own", committed);
  cpSync(join(main, ".paved"), join(committed, ".paved"), { recursive: true });
  git(committed, "add", "-f", ".paved");
  git(committed, "commit", "-qm", "commit Paved state");
  writeFileSync(join(committed, "src/feature.js"), "export const ready = true;\n");

  assert.deepEqual(resolveProjectRoot({ cwd: committed }), { projectRoot: committed, manifestPath: join(committed, ".paved/manifest.yaml") });
  const status = await cli(committed, "status");
  const data = status.data as StatusData;
  assert.equal(data.projectRoot, committed);
  assert.equal(data.stateRoot, undefined);
  assert.ok(!codes(status).includes("PAVED_WORKTREE_STATE_IN_MAIN"));
  const tested = await cli(committed, "test");
  assert.equal(tested.status, "success", JSON.stringify(tested.diagnostics));
  assert.equal(existsSync(join(committed, (tested.data as { evidence: string }).evidence)), true);
  assert.equal(existsSync(join(main, (tested.data as { evidence: string }).evidence)), false, "the main worktree's state is untouched");
  // Precedence is per worktree: a sibling without its own state still shares the main worktree's.
  assert.equal(((await cli(linked, "status")).data as StatusData).stateRoot, realpathSync(main));
});

test("consumer paths stay inside the root they resolve in", async () => {
  const { main, linked } = await repository();
  assert.equal(resolveConsumerPath(main, linked, ".paved/manifest.yaml"), join(realpathSync(main), ".paved/manifest.yaml"));
  assert.equal(resolveConsumerPath(main, linked, "src/feature.js"), join(realpathSync(linked), "src/feature.js"));
  assert.equal(resolveConsumerPath(main, linked, join(realpathSync(linked), "src/feature.js")), join(realpathSync(linked), "src/feature.js"));
  assert.equal(resolveConsumerPath(main, linked, join(realpathSync(main), ".paved/paved.lock")), join(realpathSync(main), ".paved/paved.lock"));
  for (const path of ["../outside.yaml", ".paved/../../outside.yaml", join(main, "..", "outside.yaml")]) {
    assert.throws(() => resolveConsumerPath(main, linked, path), /escapes/, path);
  }
  assert.equal(mainWorktreeRoot(main), undefined);
  assert.equal(mainWorktreeRoot(linked), realpathSync(main));
  assert.equal(isCheckoutOf(linked, main), true);
  assert.equal(isCheckoutOf(temporaryDirectory("paved-unrelated"), main), false);
});
