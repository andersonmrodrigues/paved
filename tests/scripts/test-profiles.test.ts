import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverTestFiles, selectE2ETestFiles, selectFastTestFiles } from "../../tests/test-profile.ts";

test("the fast test profile excludes only explicitly marked E2E files", () => {
  const files = [
    "tests/core/contracts.test.ts",
    "tests/cli/commands.test.ts",
    "tests/plugins/install.e2e.test.ts",
    "tests/package/bootstrap.e2e.test.ts",
  ];
  assert.deepEqual(selectFastTestFiles(files), files.slice(0, 2));
});

test("the E2E test profile selects only explicitly marked E2E files", () => {
  assert.deepEqual(selectE2ETestFiles([
    "tests/core/contracts.test.ts",
    "tests/plugins/install.e2e.test.ts",
    "tests/package/bootstrap.e2e.test.ts",
  ]), [
    "tests/plugins/install.e2e.test.ts",
    "tests/package/bootstrap.e2e.test.ts",
  ]);
});

test("the repository's fast and E2E profiles partition every test file", () => {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const all = discoverTestFiles(resolve(root, "tests"));
  const fast = selectFastTestFiles(all);
  const e2e = all.filter((file) => file.endsWith(".e2e.test.ts"));

  assert.deepEqual(e2e.map((file) => relative(root, file)), [
    "tests/acceptance/no-manual-configuration.e2e.test.ts",
    "tests/cli/status-doctor.e2e.test.ts",
    "tests/package/bootstrap.e2e.test.ts",
    "tests/plugins/failure-modes.e2e.test.ts",
    "tests/plugins/host-discovery.e2e.test.ts",
    "tests/plugins/install.e2e.test.ts",
    "tests/workflows/delivery.e2e.test.ts",
  ]);
  assert.deepEqual([...fast, ...e2e].sort(), all);
  assert.deepEqual(selectE2ETestFiles(all), e2e);
});
