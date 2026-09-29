import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const helper = join(repository, "release-changelog.mjs");

test("release changelog dates the current Unreleased section and preserves its entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "paved-release-changelog-"));
  const changelog = join(directory, "CHANGELOG.md");
  const original = "# Changelog\n\n## [1.1.0] - Unreleased\n\n### Added\n\n- Current change.\n\n## [1.0.0] - Unreleased\n\n- Historical entry.\n";
  try {
    writeFileSync(changelog, original);
    const result = spawnSync(process.execPath, [helper, changelog, "1.1.0", "1.2.0", "2026-09-29"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(changelog, "utf8"),
      "# Changelog\n\n## [1.2.0] - Unreleased\n\n## [1.1.0] - 2026-09-29\n\n### Added\n\n- Current change.\n\n## [1.0.0] - Unreleased\n\n- Historical entry.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release changelog helper fails without changing a missing current section", () => {
  const directory = mkdtempSync(join(tmpdir(), "paved-release-changelog-"));
  const changelog = join(directory, "CHANGELOG.md");
  const original = "# Changelog\n\n## [1.0.0] - Unreleased\n\n- Existing entry.\n";
  try {
    writeFileSync(changelog, original);
    const result = spawnSync(process.execPath, [helper, changelog, "1.1.0", "1.2.0", "2026-09-29"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(changelog, "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
