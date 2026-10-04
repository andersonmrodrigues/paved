import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { executableWorkflows, handledGates } from "../../cli/lib/workflow-gates/index.ts";
import { coreWorkflowIds, loadContract } from "../../cli/lib/workflow-runs.ts";

const coreRoot = join(import.meta.dirname, "..", "..");

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
