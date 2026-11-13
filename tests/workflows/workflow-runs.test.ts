import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import {
  coreWorkflowIds, isOpen, listRuns, loadContract, readRun, runCommand, validateRun, writeRun, type Run,
} from "../../cli/lib/workflow-runs.ts";

const coreRoot = join(import.meta.dirname, "..", "..");

function pending(id = "intent-0123456789abcdef0123"): Run {
  return {
    apiVersion: "paved/v1", kind: "WorkflowRun", id, revision: "abc", started_at: "2026-10-04T10:00:00Z",
    status: "cancelled", ended_at: "2026-10-04T10:05:00Z",
    classification: { parts: ["Add CSV export", "Fix the crash"] },
    inputs: [{ id: "request", value: "Add CSV export and fix the crash.", source: "human" }],
    phases: [], events: [{ at: "2026-10-04T10:00:00Z", type: "run-started" }],
  };
}

describe("workflow runs", () => {
  it("lists exactly the Core workflows", () => {
    assert.deepEqual(coreWorkflowIds(coreRoot), ["core.bug", "core.feature", "core.investigation", "core.performance", "core.refactor"]);
  });

  it("loads only Core contracts by id", () => {
    assert.equal(loadContract(coreRoot, "core.bug").id, "core.bug");
    assert.throws(() => loadContract(coreRoot, "project.deploy"), /not a Core workflow/);
    assert.throws(() => loadContract(coreRoot, "core.release"), /does not exist/);
  });

  it("accepts a cancelled run with no workflow", () => {
    validateRun(coreRoot, pending());
  });

  it("rejects a classification that disagrees with the workflow", () => {
    const contract = loadContract(coreRoot, "core.feature");
    const run: Run = {
      ...pending(), status: "running", workflow: { id: contract.id, version: contract.version },
      classification: { workflow: "core.bug", because: "x", decided_by: "agent" },
      phases: contract.phases.map((phase, index) => ({ phase: phase.phase, status: index === 0 ? "running" : "pending" })),
    };
    delete run.ended_at;
    assert.throws(() => validateRun(coreRoot, run), /classified as core.bug but runs core.feature/);
  });

  it("reads, writes and lists runs, and names the command that created them", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-runs-"));
    try {
      writeRun(projectRoot, coreRoot, pending());
      assert.equal(readRun(projectRoot, coreRoot, "intent-0123456789abcdef0123")?.status, "cancelled");
      assert.equal(readRun(projectRoot, coreRoot, "intent-ffffffffffffffffffff"), undefined);
      mkdirSync(join(projectRoot, ".paved/generated/runs"), { recursive: true });
      writeFileSync(join(projectRoot, ".paved/generated/runs/notes.txt"), "ignored");
      const runs = listRuns(projectRoot, coreRoot);
      assert.deepEqual(runs.map((run) => run.id), ["intent-0123456789abcdef0123"]);
      assert.equal(isOpen(runs[0]!), false);
      assert.equal(runCommand(runs[0]!), "intent");
      assert.equal(runCommand({ id: "fix-0123456789abcdef0123" }), "fix");
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it("rejects a document whose id differs from its file name", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-runs-"));
    try {
      mkdirSync(join(projectRoot, ".paved/generated/runs"), { recursive: true });
      writeFileSync(join(projectRoot, ".paved/generated/runs/intent-aaaaaaaaaaaaaaaaaaaa.yaml"), stringify(pending()));
      assert.throws(() => readRun(projectRoot, coreRoot, "intent-aaaaaaaaaaaaaaaaaaaa"), /does not match its document id/);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});


describe("autonomy run persistence", () => {
  it("round trips each selected profile without forcing a profile on old runs", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-profile-runs-"));
    try {
      for (const autonomy_profile of [undefined, "guided", "balanced", "autonomous"] as const) {
        const run = { ...pending(`intent-profile-${autonomy_profile ?? "absent"}`), ...(autonomy_profile === undefined ? {} : { autonomy_profile }) };
        writeRun(projectRoot, coreRoot, run);
        assert.deepEqual(readRun(projectRoot, coreRoot, run.id), run);
      }
      assert.throws(() => validateRun(coreRoot, { ...pending(), autonomy_profile: "unchecked" } as unknown as Run), /autonomy_profile/);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});


it("refuses changing a persisted selection while allowing default selection at classification", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "paved-profile-immutable-"));
  try {
    for (const profile of [undefined, "guided", "balanced", "autonomous"] as const) {
      const run = { ...pending(`intent-immutable-${profile ?? "absent"}`), ...(profile === undefined ? {} : { autonomy_profile: profile }) };
      writeRun(projectRoot, coreRoot, run);
      assert.throws(() => writeRun(projectRoot, coreRoot, { ...run, autonomy_profile: profile === "guided" ? "balanced" : "guided" }), /autonomy profile.*cannot change/i);
      if (profile !== undefined) {
        const cleared = { ...run };
        delete cleared.autonomy_profile;
        assert.throws(() => writeRun(projectRoot, coreRoot, cleared), /autonomy profile.*cannot change/i);
      }
    }
  } finally { rmSync(projectRoot, { recursive: true, force: true }); }
});
