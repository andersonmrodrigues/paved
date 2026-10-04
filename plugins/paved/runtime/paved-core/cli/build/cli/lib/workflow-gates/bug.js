import { resolveSafePath } from "../safe-path.js";
import { blocked, failedTestingEvidence, projectRelative } from "./shared.js";
export const bugGates = {
    workflow: "core.bug",
    handles: ["expected-behavior-known", "cause-confirmed", "test-failed-first"],
    relays: ["discovery"],
    phases: {
        context: (context) => {
            context.phase.gates = [{ id: "expected-behavior-known", status: "passed" }];
            return { kind: "pass" };
        },
        discovery: async (context) => {
            let path = context.evidence;
            if (!path) {
                const tested = await context.tools.test();
                if (tested.status === "awaiting_input")
                    return { kind: "relay", result: tested };
                const produced = tested.data?.evidence;
                if (produced)
                    path = resolveSafePath(context.projectRoot, produced);
            }
            if (!path || !failedTestingEvidence(context, path, context.run)) {
                return blocked("PAVED_WORKFLOW_CAUSE_UNCONFIRMED", "A confirmed cause needs a current failed regression result from the governed testing Tool.", "Write a regression test that reproduces the report on the unfixed code, then advance discovery again with --note <observed cause>.");
            }
            context.phase.gates = [{ id: "cause-confirmed", status: "passed" }];
            return { kind: "pass", ref: projectRelative(context.projectRoot, path) };
        },
        implementation: (context) => {
            const reproduced = context.run.events.some((event) => event.phase === "discovery" && event.type === "evidence-recorded" && event.ref?.startsWith(".paved/generated/evidence/"));
            if (!reproduced) {
                return blocked("PAVED_WORKFLOW_REGRESSION_MISSING", "No failed pre-fix regression result was recorded.", "Reproduce the failure through the governed testing Tool before implementing the fix.");
            }
            context.phase.gates = [{ id: "test-failed-first", status: "passed" }];
            return { kind: "pass" };
        },
    },
};
