import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contract = readFileSync(join(root, "docs/concepts/agent-integration.md"), "utf8");

describe("Agent Integration Contract", () => {
  it("declares the version and every required public capability", () => {
    assert.match(contract, /paved\/agent\/v1/);
    for (const capability of ["Discovery", "Context", "Skills", "Workflows", "Tools", "Verification", "Status", "Diagnostics"]) {
      assert.match(contract, new RegExp(`\\b${capability}\\b`));
    }
  });

  it("pins machine-readable result, diagnostics, lifecycle, and exit semantics", () => {
    for (const term of ["command", "status", "data", "diagnostics", "UNINITIALIZED", "READY", "STALE", "internal", "ownership"]) {
      assert.match(contract, new RegExp(`\\b${term}\\b`));
    }
    for (const code of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      assert.match(contract, new RegExp(`\\|\\s*[^|]+\\s*\\|\\s*${code}\\s*\\|`));
    }
  });

  it("explicitly keeps integrations outside Core internals", () => {
    assert.match(contract, /Public versus internal/);
    assert.match(contract, /must not contain branches for Codex/);
    assert.match(contract, /must not\s+import or depend on them/);
    assert.match(contract, /Codex and Claude Code projections/);
    assert.doesNotMatch(contract, /Phase \d+/);
  });

  it("documents conversational command metadata and the canonical protocol", () => {
    assert.match(contract, /`conversational` or\s+`read-only`/);
    assert.match(contract, /decision_sources|decisions come from/);
    assert.match(contract, /core\.decisions\.decisions/);
  });
});
