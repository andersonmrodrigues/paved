import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contract = readFileSync(join(root, "docs/concepts/agent-integration.md"), "utf8");
const workflows = readFileSync(join(root, "docs/concepts/workflows.md"), "utf8");
const state = readFileSync(join(root, "docs/concepts/workflow-state.md"), "utf8");
const catalog = readFileSync(join(root, "docs/catalog.md"), "utf8");
const installation = readFileSync(join(root, "docs/getting-started/installing-the-plugin.md"), "utf8");

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

  it("documents the advisory prompt hook and host trust requirements", () => {
    assert.match(contract, /UserPromptSubmit/);
    assert.match(contract, /advisory/i);
    assert.match(contract, /initialized/i);
    assert.match(installation, /UserPromptSubmit/);
    assert.match(installation, /review and trust/i);
    assert.match(installation, /initialized/i);
    assert.match(installation, /fail\s+open/i);
    assert.doesNotMatch(installation, /create (?:a )?CLAUDE\.md/i);
    assert.doesNotMatch(installation, /\.claude\/settings\.json/);
  });

  it("documents the shared resolved phase projection without host permission grants", () => {
    const controls = contract.split("## Active workflow context and controls")[1]?.split("## Diagnostics")[0] ?? "";
    for (const field of ["data.phaseContext", "phase", "goal", "skills", "tools", "toolPolicies", "fragments", "data.routing"]) {
      assert.ok(controls.includes("`" + field + "`"), `missing phase projection field ${field}`);
    }
    assert.doesNotMatch(controls, /Codex|Claude Code|Cursor|OpenCode/);
    assert.match(contract, /bound fragment guidance/);
    assert.match(contract, /same protocol\s+for every host/);
    assert.match(contract, /host permissions remain\s+authoritative/i);
    assert.match(contract, /fail closed\s+before phase dispatch/);
    assert.match(contract, /allow.*never.*authoriz/i);
    assert.match(contract, /`ask` requires\s+the host's own approval flow/i);
    assert.match(contract, /deny.*excludes/i);
    assert.match(contract, /unspecified Tools retain\s+existing host behavior/);
  });

  it("pins autonomy compatibility, immutability and mandatory stops", () => {
    for (const text of [contract, workflows]) {
      for (const profile of ["guided", "balanced", "autonomous"]) assert.ok(text.includes("`" + profile + "`"));
      assert.match(text, /independent review/);
      assert.match(text, /verification/);
      assert.match(text, /evidence/);
      assert.match(text, /required input/);
      assert.match(text, /approvals/);
    }
    assert.match(state, /autonomy_profile/);
    assert.match(state, /immutable/);
    assert.match(workflows, /autonomy.default_profile/);
    assert.match(workflows, /--autonomy/);
    assert.match(workflows, /both.*absent[\s\S]*existing behavior/);
    assert.match(workflows, /at most one phase per call/);
  });

  it("documents exact fragment binding and phase policy composition", () => {
    assert.match(workflows, /\{\{ inputs\.<id> \}\}/);
    assert.match(workflows, /missing or extra bindings/);
    assert.match(workflows, /unresolved placeholders/);
    assert.match(workflows, /cannot.*phases, gates[\s\S]*other fragments/);
    assert.match(workflows, /same-action duplicates/);
    assert.match(workflows, /cross-action conflicts/);
    assert.match(workflows, /required Tool[\s\S]*fragment[\s\S]*required skill dependencies/);
    assert.match(workflows, /local.*tool_policies/);
    assert.match(catalog, /core\.fragment\.context-discovery/);
    assert.match(catalog, /core\/workflow-fragments\/context-discovery\/fragment\.yaml/);
  });

  it("documents the local Workbench and its privacy boundary", () => {
    assert.match(installation, /paved workbench start/);
    assert.match(installation, /hashed session id/i);
    assert.match(installation, /never send prompt text/i);
    assert.match(installation, /read-only/);
  });
});
