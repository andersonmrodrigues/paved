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

test("the plugin moves by the same kind of bump as the Core", () => {
  for (const [bump, expected] of [["patch", "2.1.1 3.4.6"], ["minor", "2.2.0 3.5.0"], ["major", "3.0.0 4.0.0"]]) {
    const result = calculate("2.1.0", "3.4.5", bump!);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, bump);
  }
});

test("the plugin major never stays below the major of the runtime it bundles", () => {
  for (const bump of ["patch", "minor"]) {
    const result = calculate("2.0.0", "1.9.13", bump);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split(" ")[1], "2.0.0", bump);
  }
  const major = calculate("1.16.1", "1.9.12", "major");
  assert.equal(major.stdout.trim(), "2.0.0 2.0.0");
});

test("release version helper rejects malformed versions", () => {
  const result = calculate("1.8", "1.9.0", "minor");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semantic version/i);
});
