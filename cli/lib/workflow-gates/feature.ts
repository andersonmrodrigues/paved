import type { WorkflowGates } from "./index.ts";

export const featureGates: WorkflowGates = {
  workflow: "core.feature",
  handles: ["scope-clear", "claims-planned", "boundary-exception"],
  planningGates: [
    { id: "claims-planned", status: "passed" },
    { id: "boundary-exception", status: "not-applicable", reason: "No exception was requested in the approved plan." },
  ],
  phases: {
    context: (context) => {
      context.phase.gates = [{ id: "scope-clear", status: "passed" }];
      return { kind: "pass" };
    },
  },
};
