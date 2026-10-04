import type { WorkflowGates } from "./index.ts";
import { blocked, now } from "./shared.ts";

export const refactorGates: WorkflowGates = {
  workflow: "core.refactor",
  handles: ["behavior-pinned", "uncovered-risk"],
  relays: ["discovery"],
  phases: {
    discovery: async (context) => {
      if (!context.evidence) return blocked("PAVED_WORKFLOW_BASELINE_MISSING", "A refactor needs existing behavior pinned by test evidence.", "Supply --evidence <repository-relative-path> for the baseline.");
      const baseline = await context.tools.test();
      if (baseline.status === "awaiting_input") return { kind: "relay", result: baseline };
      if (baseline.status !== "success") return blocked("PAVED_WORKFLOW_BASELINE_FAILED", "The governed baseline test did not pass before refactoring.", "Configure a valid testing Tool and establish a passing baseline before changing code.");
      context.run.events.push({ at: now(), type: "tool-invoked", phase: "discovery", ref: "testing-run" });
      context.phase.gates = [
        { id: "behavior-pinned", status: "passed" },
        { id: "uncovered-risk", status: "not-applicable", reason: "Baseline test evidence was supplied." },
      ];
      return { kind: "pass" };
    },
  },
};
