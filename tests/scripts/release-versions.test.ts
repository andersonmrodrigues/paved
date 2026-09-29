import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const helper = resolve(repository, "release-versions.mjs");

function calculate(core: string, plugin: string, bump: string) {
  return spawnSync(process.execPath, [helper, core, plugin, bump], { encoding: "utf8" });
}

test("Core release bumps Core and independently patch-bumps the plugin", () => {
  const result = calculate("1.8.0", "1.9.0", "minor");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1.9.0 1.9.1");
});

test("Core patch release also patch-bumps the plugin", () => {
  const result = calculate("1.8.0", "2.3.4", "patch");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1.8.1 2.3.5");
});

test("release version helper rejects malformed versions", () => {
  const result = calculate("1.8", "1.9.0", "minor");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semantic version/i);
});
