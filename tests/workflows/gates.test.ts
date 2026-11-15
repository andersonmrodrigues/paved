import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { executableWorkflows, handledGates } from "../../cli/lib/workflow-gates/index.ts";
import { changedSinceVerification, fingerprint, sourceChangedAction, sourceMovedSinceVerification } from "../../cli/lib/workflow-gates/shared.ts";
import { coreWorkflowIds, loadContract, type Run } from "../../cli/lib/workflow-runs.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const coreRoot = join(import.meta.dirname, "..", "..");
afterEach(cleanupTemporaryDirectories);

describe("workflow gate handlers", () => {
  it("make every Core workflow executable", () => {
    assert.deepEqual(executableWorkflows(), coreWorkflowIds(coreRoot));
  });

  for (const id of coreWorkflowIds(coreRoot)) {
    it(`decide exactly the gates of ${id}`, () => {
      const declared = new Set(loadContract(coreRoot, id).phases.flatMap((phase) => (phase.gates ?? []).map((gate) => gate.id)));
      const handled = handledGates(id);
      for (const gate of declared) assert.ok(handled.has(gate), `${id}: gate ${gate} has no handler`);
      for (const gate of handled) assert.ok(declared.has(gate), `${id}: handler for unknown gate ${gate}`);
    });
  }
});

describe("verified source fingerprint", () => {
  it("compares the latest recorded fingerprint regardless of status, while preserving completed-only reporting", () => {
    const root = temporaryDirectory("paved-verified-source");
    writeFileSync(join(root, "feature.js"), "export const value = 1;\n");
    const run: Run = {
      apiVersion: "paved/v1", kind: "WorkflowRun", id: "feature-test", revision: "head",
      started_at: new Date().toISOString(), status: "running", inputs: [], phases: [], events: [],
    };
    assert.equal(sourceMovedSinceVerification(root, run), false);
    run.events.push({ at: run.started_at, type: "verification-executed", detail: `source_sha256=${fingerprint(root)}` });
    writeFileSync(join(root, "feature.js"), "export const value = 2;\n");
    assert.equal(sourceMovedSinceVerification(root, run), true);
    assert.equal(changedSinceVerification(root, run), false);
    run.status = "completed";
    assert.equal(changedSinceVerification(root, run), true);
    run.events.push({ at: run.started_at, type: "verification-executed", detail: `source_sha256=${fingerprint(root)}` });
    assert.equal(sourceMovedSinceVerification(root, run), false);
    assert.equal(changedSinceVerification(root, run), false);
  });

  it("labels handoff paths approximate when the verification snapshot is unavailable", () => {
    const root = temporaryDirectory("paved-verified-source");
    const run: Run = {
      apiVersion: "paved/v1", kind: "WorkflowRun", id: "feature-test", revision: "head",
      started_at: new Date().toISOString(), status: "running", inputs: [], phases: [],
      events: [{ at: new Date().toISOString(), type: "verification-executed", detail: `source_sha256=${"a".repeat(64)}` }],
      handoff: { updated_at: new Date().toISOString(), phase: "implementation", summary: "work", revision: "head",
        source_sha256: "a".repeat(64), changed_paths: ["feature.js"] },
    };
    assert.match(sourceChangedAction(root, run), /approximate handoff paths: feature\.js/);
  });
});
