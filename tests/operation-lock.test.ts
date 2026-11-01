import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { acquireConsumerOperationLock, ConsumerOperationLockedError, withConsumerOperationScope } from "../cli/lib/operation-lock.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.ts";

afterEach(cleanupTemporaryDirectories);

test("consumer mutations share one exclusive operation lock and release it for reuse", () => {
  const consumer = temporaryDirectory("paved-operation-lock");
  const lockPath = join(consumer, ".paved-operation-lock");
  const release = acquireConsumerOperationLock(consumer, "update");

  assert.throws(() => acquireConsumerOperationLock(consumer, "generate"), ConsumerOperationLockedError);
  assert.match(readFileSync(join(lockPath, "owner.json"), "utf8"), /"operation":"update"/);

  release();
  release();
  assert.equal(existsSync(lockPath), false);

  const releaseNext = acquireConsumerOperationLock(consumer, "verify");
  releaseNext();
  assert.equal(existsSync(lockPath), false);
});

test("stale operation locks fail closed and preserve their recovery evidence", () => {
  const consumer = temporaryDirectory("paved-stale-operation");
  const lockPath = join(consumer, ".paved-operation-lock");
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), '{"operation":"generate","pid":-1}\n');

  assert.throws(() => acquireConsumerOperationLock(consumer, "update"), ConsumerOperationLockedError);
  assert.equal(readFileSync(join(lockPath, "owner.json"), "utf8"), '{"operation":"generate","pid":-1}\n');
});

test("only the direct update child can borrow a launcher-held operation lock", () => {
  const consumer = temporaryDirectory("paved-parent-operation");
  const lockPath = join(consumer, ".paved-operation-lock");
  mkdirSync(lockPath);
  const token = "a".repeat(48);
  const owner = join(lockPath, "owner.json");
  const script = `import { acquireConsumerOperationLock } from ${JSON.stringify(join(process.cwd(), "cli/lib/operation-lock.ts"))};
    acquireConsumerOperationLock(${JSON.stringify(consumer)}, process.argv[1])();`;
  writeFileSync(owner, JSON.stringify({ operation: "auto-update", pid: process.pid, token }));
  const run = (operation: string, value = token) => spawnSync(process.execPath, ["--input-type=module", "-e", script, operation], {
    encoding: "utf8", env: { ...process.env, PAVED_PARENT_OPERATION_TOKEN: value },
  });

  assert.equal(run("update").status, 0);
  assert.equal(existsSync(owner), true, "child does not release its parent's lock");
  assert.notEqual(run("generate").status, 0);
  assert.notEqual(run("update", "b".repeat(48)).status, 0);
  writeFileSync(owner, JSON.stringify({ operation: "auto-update", pid: process.pid + 1, token }));
  assert.notEqual(run("update").status, 0);
  assert.equal(existsSync(owner), true);
});

test("a workflow scope reuses its own lock for nested phases but remains exclusive to other processes", async () => {
  const consumer = temporaryDirectory("paved-workflow-operation");
  assert.throws(() => withConsumerOperationScope(consumer, () => {}));
  const release = acquireConsumerOperationLock(consumer, "workflow");
  try {
    await withConsumerOperationScope(consumer, async () => {
      acquireConsumerOperationLock(consumer, "decision:intent")();
      await Promise.resolve();
      acquireConsumerOperationLock(consumer, "verify")();
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { acquireConsumerOperationLock } from ${JSON.stringify(join(process.cwd(), "cli/lib/operation-lock.ts"))};
        acquireConsumerOperationLock(${JSON.stringify(consumer)}, 'update');`], { encoding: "utf8" });
      assert.notEqual(child.status, 0);
      assert.match(readFileSync(join(consumer, ".paved-operation-lock/owner.json"), "utf8"), /"operation":"workflow"/);
    });
    assert.throws(() => acquireConsumerOperationLock(consumer, "verify"), ConsumerOperationLockedError);
  } finally { release(); }
  assert.equal(existsSync(join(consumer, ".paved-operation-lock")), false);
});
