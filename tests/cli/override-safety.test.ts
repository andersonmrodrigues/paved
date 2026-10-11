import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { inspectOverrides } from "../../cli/lib/override-safety.ts";
import { resolveTestingTool } from "../../cli/lib/test-runner.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const core = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

function write(root: string, path: string, document: unknown): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), stringify(document));
}

function projectSelecting(implementation: string): string {
  const project = temporaryDirectory("paved-override-safety");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Manifest", adapters: [] });
  write(project, ".paved/tool-implementations/testing/run.yaml", {
    apiVersion: "paved/v1", kind: "ToolImplementation", id: "project.testing.run", tool: "core.testing.run",
    version: "0.1.0", contract: "^0.1.0", source: "project", environments: ["local"],
    invocation: { type: "command", executable: "node", arguments: ["--version"] }, availability: "available",
  });
  write(project, ".paved/overrides/overrides.yaml", {
    apiVersion: "paved/v1", kind: "Overrides",
    tools: [{ target: "core.testing.run", action: "select-implementation", implementation, owner: "team", reason: "Project test command" }],
  });
  return project;
}

test("an override may select a project implementation of an inherited Tool", () => {
  const project = projectSelecting("project.testing.run");

  const errors = inspectOverrides(project, core, []).filter((item) => item.severity === "error");

  assert.deepEqual(errors, []);
  const resolution = resolveTestingTool(project, core);
  assert.equal(resolution.status, "resolved", JSON.stringify(resolution));
  if (resolution.status === "resolved") assert.equal(resolution.implementation.id, "project.testing.run");
});

test("an override selecting an implementation that exists nowhere is still rejected", () => {
  const project = projectSelecting("project.testing.missing");

  const codes = inspectOverrides(project, core, []).map((item) => item.code);

  assert.ok(codes.includes("PAVED_OVERRIDE_IMPLEMENTATION_MISSING"), codes.join(", "));
});
