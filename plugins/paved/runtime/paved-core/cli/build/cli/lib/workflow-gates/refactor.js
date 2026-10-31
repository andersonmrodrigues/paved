import { blocked, environmentBlocked, now, testOutcomes } from "./shared.js";
export const refactorGates = {
    workflow: "core.refactor",
    handles: ["behavior-pinned", "uncovered-risk"],
    relays: ["discovery"],
    phases: {
        // A passing run of the governed tests is what pins behavior; --evidence only adds a pointer to it.
        discovery: async (context) => {
            const baseline = await context.tools.test();
            if (baseline.status === "awaiting_input")
                return { kind: "relay", result: baseline };
            if (baseline.status !== "success") {
                const unavailable = environmentBlocked(baseline.diagnostics);
                if (unavailable)
                    return unavailable;
                const failing = testOutcomes(baseline).filter((item) => item.status !== "passed").map((item) => item.tool);
                return blocked("PAVED_WORKFLOW_BASELINE_FAILED", `The governed baseline test did not pass before refactoring${failing.length ? `: ${failing.join(", ")}` : ""}.`, "A refactor keeps behavior that tests already prove. Make the tests pass first, exclude the ones that cannot run here from the testing Tool, "
                    + `or, if the change is meant to alter behavior, cancel with paved intent --run ${context.run.id} --abandon and start it again with --workflow feature or bug.`);
            }
            const ref = baseline.data?.evidence;
            context.run.events.push({ at: now(), type: "tool-invoked", phase: "discovery", ref: ref ?? "testing-run" });
            context.phase.gates = [
                { id: "behavior-pinned", status: "passed" },
                { id: "uncovered-risk", status: "not-applicable", reason: "A passing baseline test run was recorded." },
            ];
            return context.evidence || ref === undefined ? { kind: "pass" } : { kind: "pass", ref };
        },
    },
};
