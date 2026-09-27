import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { atomicWriteFileSync } from "../cli/lib/atomic-write.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./helpers.ts";

afterEach(cleanupTemporaryDirectories);

test("atomically replaces a persisted file without leaving staging artifacts", () => {
  const directory = temporaryDirectory("paved-atomic-write");
  const target = join(directory, "state.json");
  writeFileSync(target, '{"state":"old"}\n');

  atomicWriteFileSync(target, '{"state":"new"}\n');

  assert.equal(readFileSync(target, "utf8"), '{"state":"new"}\n');
  assert.deepEqual(readdirSync(directory), ["state.json"]);
});

test("atomic replacement preserves an existing file's permission bits", { skip: process.platform === "win32" }, () => {
  const directory = temporaryDirectory("paved-atomic-mode");
  const target = join(directory, "private.yaml");
  writeFileSync(target, "old");
  chmodSync(target, 0o600);

  atomicWriteFileSync(target, "new");

  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(readFileSync(target, "utf8"), "new");
});

test("failed replacement preserves the target and removes its temporary file", () => {
  const directory = temporaryDirectory("paved-atomic-failure");
  const target = join(directory, "state");
  mkdirSync(target);
  writeFileSync(join(target, "preserved"), "original");

  assert.throws(() => atomicWriteFileSync(target, "replacement"));

  assert.equal(readFileSync(join(target, "preserved"), "utf8"), "original");
  assert.deepEqual(readdirSync(directory), ["state"]);
});
