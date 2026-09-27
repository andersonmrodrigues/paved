import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchCli } from "../../cli/runtime.ts";
import { exitCode, type CommandResult } from "../../cli/result.ts";
import { cleanupTemporaryDirectories, temporaryDirectory, temporaryFixture } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VERIFICATION_FIXTURE = join(ROOT, "tests/cli/fixtures/verification");
afterEach(cleanupTemporaryDirectories);

test("major local operations report a non-gating timing baseline", async (context) => {
  const consumer = temporaryDirectory("paved-performance");
  mkdirSync(join(consumer, "src"), { recursive: true });
  writeFileSync(join(consumer, "README.md"), "# Performance fixture\n");
  writeFileSync(join(consumer, "src", "App.java"), "package example; class App {}\n");
  const verificationConsumer = temporaryFixture(VERIFICATION_FIXTURE, "paved-performance-verify");
  chmodSync(join(verificationConsumer, ".paved/tools/marker.mjs"), 0o755);
  chmodSync(join(verificationConsumer, ".paved/tools/unlisted.mjs"), 0o755);

  const durations: Record<string, number> = {};
  const measure = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await action();
    durations[name] = Number((performance.now() - start).toFixed(2));
    return result;
  };
  const run = (command: string, projectRoot: string) => dispatchCli({
    argv: [command, "--project", projectRoot],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });
  const completed = (result: CommandResult) => {
    assert.ok(exitCode(result) <= 1, JSON.stringify(result.diagnostics));
  };

  completed(await measure("init", () => dispatchCli({
    argv: ["init", "--project", consumer, "--no-generate"],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  })));
  completed(await measure("generate", () => run("generate", consumer)));

  writeFileSync(join(consumer, "README.md"), "# Updated performance fixture\n");
  completed(await measure("update", () => run("update", consumer)));
  completed(await measure("verify", () => run("verify", verificationConsumer)));
  completed(await measure("status", () => run("status", consumer)));
  completed(await measure("doctor", () => run("doctor", consumer)));
  completed(await measure("gardener", () => run("gardener", consumer)));

  assert.deepEqual(Object.keys(durations), ["init", "generate", "update", "verify", "status", "doctor", "gardener"]);
  assert.ok(Object.values(durations).every((duration) => Number.isFinite(duration) && duration >= 0));
  context.diagnostic(`Informational local baseline (ms, no machine-specific thresholds): ${JSON.stringify(durations)}`);
});
