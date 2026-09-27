import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupTemporaryDirectories, temporaryDirectory, temporaryFixture } from "./helpers.ts";

afterEach(cleanupTemporaryDirectories);

test("temporary consumer paths have valid stable-form identities and are cleaned up", () => {
  const first = temporaryDirectory("A long, mixed-case fixture name that exceeds the supported prefix");
  const second = temporaryDirectory("A long, mixed-case fixture name that exceeds the supported prefix");

  assert.notEqual(first, second);
  assert.ok(basename(first).length <= 64);
  assert.match(basename(first), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(existsSync(first));
  assert.ok(existsSync(second));

  cleanupTemporaryDirectories();

  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), false);
});

test("temporary fixture copies are isolated from their static source", () => {
  const sourcePath = fileURLToPath(new URL("./fixtures/consumers/consumer-a/", import.meta.url));
  const copy = temporaryFixture(sourcePath, "paved-consumer-fixture");
  const sourceReadme = join(sourcePath, "README.md");
  const copyReadme = join(copy, "README.md");
  const original = readFileSync(sourceReadme);

  assert.ok(existsSync(copy));
  assert.notEqual(copy, sourcePath);
  writeFileSync(copyReadme, "temporary mutation\n");
  assert.deepEqual(readFileSync(sourceReadme), original);
});
