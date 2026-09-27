import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { acquireConsumerOperationLock, ConsumerOperationLockedError } from "../cli/lib/operation-lock.ts";
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
