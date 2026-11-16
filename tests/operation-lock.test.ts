import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  acquireConsumerOperationLock, ConsumerOperationLockedError, OWNERLESS_LOCK_STALE_AFTER_MS, takeReclaimedOperationLocks, withConsumerOperationScope,
} from "../cli/lib/operation-lock.ts";
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

test("a recent lock without a usable owner fails closed and preserves its recovery evidence", () => {
  const consumer = temporaryDirectory("paved-stale-operation");
  const lockPath = join(consumer, ".paved-operation-lock");
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), '{"operation":"generate","pid":-1}\n');

  assert.throws(() => acquireConsumerOperationLock(consumer, "update"), (error: unknown) =>
    error instanceof ConsumerOperationLockedError && error.reason === "acquiring" && /reclaimed automatically/.test(error.remediation));
  assert.equal(readFileSync(join(lockPath, "owner.json"), "utf8"), '{"operation":"generate","pid":-1}\n');
});

/** A pid that belonged to a process which has already exited and been reaped. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid!;
}

function staleLock(consumer: string, owner: Record<string, unknown> | string, ageMs = 0): string {
  const lockPath = join(consumer, ".paved-operation-lock");
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(join(lockPath, "owner.json"), then, then);
    utimesSync(lockPath, then, then);
  }
  return lockPath;
}

test("a lock whose owner process exited is reclaimed with a warning naming the previous operation", () => {
  takeReclaimedOperationLocks();
  const consumer = temporaryDirectory("paved-reclaim-exited");
  const pid = exitedPid();
  const lockPath = staleLock(consumer, { operation: "generate", pid, started_at: "2026-11-01T10:00:00.000Z" });

  const release = acquireConsumerOperationLock(consumer, "verify");
  const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { operation: string; pid: number; host: string };
  assert.deepEqual([owner.operation, owner.pid, owner.host], ["verify", process.pid, hostname()]);
  assert.deepEqual(takeReclaimedOperationLocks(), [{
    projectRoot: consumer, reason: "owner-exited", previous: { operation: "generate", pid, started_at: "2026-11-01T10:00:00.000Z" },
  }]);
  release();
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(`${lockPath}.reclaim`), false);
});

test("a lock held by a running process keeps failing and names its operation, pid and start time", () => {
  const consumer = temporaryDirectory("paved-live-owner");
  const lockPath = staleLock(consumer, { operation: "update", pid: process.pid, started_at: "2026-11-01T10:00:00.000Z" }, 60 * 60 * 1000);

  assert.throws(() => acquireConsumerOperationLock(consumer, "generate"), (error: unknown) => {
    assert.ok(error instanceof ConsumerOperationLockedError);
    assert.equal(error.reason, "running");
    assert.match(error.message, new RegExp(`update \\(pid ${process.pid}, started 2026-11-01T10:00:00.000Z\\)`));
    assert.match(error.remediation, /Wait for update to finish/);
    return true;
  });
  assert.equal(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")).operation, "update");
});

test("an ownerless or unreadable lock is reclaimed only once it is older than the safe threshold", () => {
  takeReclaimedOperationLocks();
  const consumer = temporaryDirectory("paved-reclaim-unreadable");
  const lockPath = join(consumer, ".paved-operation-lock");
  mkdirSync(lockPath);
  assert.throws(() => acquireConsumerOperationLock(consumer, "verify"), ConsumerOperationLockedError);

  const old = new Date(Date.now() - OWNERLESS_LOCK_STALE_AFTER_MS - 1000);
  utimesSync(lockPath, old, old);
  acquireConsumerOperationLock(consumer, "verify")();
  assert.deepEqual(takeReclaimedOperationLocks().map((item) => item.reason), ["owner-unreadable"]);

  staleLock(consumer, "{not json", OWNERLESS_LOCK_STALE_AFTER_MS + 1000);
  acquireConsumerOperationLock(consumer, "verify")();
  assert.deepEqual(takeReclaimedOperationLocks().map((item) => item.reason), ["owner-unreadable"]);
  assert.equal(existsSync(lockPath), false);
});

test("reclamation never follows links, removes unexpected files or judges another host's process", () => {
  takeReclaimedOperationLocks();
  const pid = exitedPid();
  const old = OWNERLESS_LOCK_STALE_AFTER_MS + 1000;

  const linked = temporaryDirectory("paved-reclaim-link");
  const target = temporaryDirectory("paved-reclaim-target");
  writeFileSync(join(target, "owner.json"), JSON.stringify({ operation: "generate", pid }));
  symlinkSync(target, join(linked, ".paved-operation-lock"));
  assert.throws(() => acquireConsumerOperationLock(linked, "verify"), (error: unknown) =>
    error instanceof ConsumerOperationLockedError && error.reason === "unexpected-contents");
  assert.equal(lstatSync(join(linked, ".paved-operation-lock")).isSymbolicLink(), true);
  assert.equal(existsSync(join(target, "owner.json")), true);

  const ownerLink = temporaryDirectory("paved-reclaim-owner-link");
  mkdirSync(join(ownerLink, ".paved-operation-lock"));
  symlinkSync(join(target, "owner.json"), join(ownerLink, ".paved-operation-lock/owner.json"));
  assert.throws(() => acquireConsumerOperationLock(ownerLink, "verify"), ConsumerOperationLockedError);
  assert.equal(existsSync(join(target, "owner.json")), true);

  const extra = temporaryDirectory("paved-reclaim-extra");
  const extraLock = staleLock(extra, { operation: "generate", pid }, old);
  writeFileSync(join(extraLock, "notes.txt"), "keep");
  assert.throws(() => acquireConsumerOperationLock(extra, "verify"), (error: unknown) =>
    error instanceof ConsumerOperationLockedError && error.reason === "unexpected-contents");
  assert.equal(readFileSync(join(extraLock, "notes.txt"), "utf8"), "keep");

  const remote = temporaryDirectory("paved-reclaim-remote");
  staleLock(remote, { operation: "generate", pid, host: "another-host.example", started_at: "2026-11-01T10:00:00.000Z" }, old);
  assert.throws(() => acquireConsumerOperationLock(remote, "verify"), (error: unknown) => {
    assert.ok(error instanceof ConsumerOperationLockedError);
    assert.equal(error.reason, "other-host");
    assert.match(error.message, new RegExp(`generate \\(pid ${pid} on host another-host.example, started 2026-11-01T10:00:00.000Z\\)`));
    return true;
  });
  assert.deepEqual(takeReclaimedOperationLocks(), []);
});

test("a reclamation in progress or interrupted leaves the stale lock to its reclaimer", () => {
  takeReclaimedOperationLocks();
  const consumer = temporaryDirectory("paved-reclaim-marker");
  const lockPath = staleLock(consumer, { operation: "generate", pid: exitedPid() });
  const marker = `${lockPath}.reclaim`;
  mkdirSync(marker);
  assert.throws(() => acquireConsumerOperationLock(consumer, "verify"), (error: unknown) =>
    error instanceof ConsumerOperationLockedError && error.reason === "reclaiming");

  const old = new Date(Date.now() - OWNERLESS_LOCK_STALE_AFTER_MS - 1000);
  utimesSync(marker, old, old);
  assert.throws(() => acquireConsumerOperationLock(consumer, "verify"), (error: unknown) =>
    error instanceof ConsumerOperationLockedError && error.reason === "reclaim-interrupted" && error.remediation.includes(".paved-operation-lock.reclaim"));
  assert.equal(existsSync(join(lockPath, "owner.json")), true);
  assert.deepEqual(takeReclaimedOperationLocks(), []);
});

test("concurrent processes reclaiming one stale lock never hold it at the same time", async () => {
  const consumer = temporaryDirectory("paved-reclaim-race");
  staleLock(consumer, { operation: "generate", pid: exitedPid() });
  const script = `import { acquireConsumerOperationLock, takeReclaimedOperationLocks } from ${JSON.stringify(join(process.cwd(), "cli/lib/operation-lock.ts"))};
    let release;
    try { release = acquireConsumerOperationLock(${JSON.stringify(consumer)}, "verify"); }
    catch (error) { console.log(JSON.stringify({ locked: error.reason })); process.exit(0); }
    const acquired = Date.now();
    const reclaimed = takeReclaimedOperationLocks().length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const released = Date.now();
    release();
    console.log(JSON.stringify({ acquired, released, reclaimed }));`;
  const outputs = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  })));
  const results = outputs.map((line) => JSON.parse(line) as { acquired?: number; released?: number; reclaimed?: number; locked?: string });
  const holders = results.filter((item) => item.acquired !== undefined).sort((a, b) => a.acquired! - b.acquired!);
  assert.ok(holders.length >= 1, outputs.join("\n"));
  for (let index = 1; index < holders.length; index += 1) {
    assert.ok(holders[index]!.acquired! >= holders[index - 1]!.released!, `overlapping holders: ${outputs.join("\n")}`);
  }
  assert.equal(results.reduce((sum, item) => sum + (item.reclaimed ?? 0), 0), 1, outputs.join("\n"));
  assert.equal(existsSync(join(consumer, ".paved-operation-lock")), false);
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
  const generate = run("generate");
  assert.notEqual(generate.status, 0);
  assert.match(generate.stderr, /auto-update \(pid \d+, started at an unknown time\) holds .paved-operation-lock and is still running/);
  assert.notEqual(run("update", "b".repeat(48)).status, 0);
  // A running process that is not the direct parent cannot lend its lock.
  writeFileSync(owner, JSON.stringify({ operation: "auto-update", pid: 1, token }));
  assert.notEqual(run("update").status, 0);
  assert.equal(JSON.parse(readFileSync(owner, "utf8")).token, token);
  // A launcher that died leaves an ordinary stale lock, which the child reclaims and releases.
  writeFileSync(owner, JSON.stringify({ operation: "auto-update", pid: exitedPid(), token }));
  assert.equal(run("update").status, 0);
  assert.equal(existsSync(lockPath), false);
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
