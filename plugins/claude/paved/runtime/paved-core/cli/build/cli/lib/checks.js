// Checks on check definitions (check.schema.yaml) that JSON Schema cannot express: the
// tool exists, observes rather than destroys, and accepts the inputs the check fixes;
// Core checks stay free of technology names. Run after schema validation and reference
// resolution. See docs/concepts/checks.md.
import { genericityProblems } from "./skills.js";
export function assessCheck(check, tools) {
    const problems = [];
    const tool = tools.get(check.tool);
    if (tool === undefined) {
        problems.push(`${check.id} runs unknown tool ${check.tool}`);
    }
    else {
        // Verification observes. A check that can destroy data or change shared state would
        // make running the verification itself a risk.
        if (tool.safety === "destructive" || tool.safety === "high-impact")
            problems.push(`${check.id} runs ${tool.safety} tool ${check.tool}; checks may only use read-only or safe-mutation tools`);
        const declared = new Set(tool.inputs.map((i) => i.name));
        for (const name of Object.keys(check.inputs ?? {})) {
            if (!declared.has(name))
                problems.push(`${check.id} sets input "${name}", which ${check.tool} does not declare`);
        }
        // The tool would be stopped first, so a longer check timeout promises time it cannot get.
        if (check.timeout_seconds !== undefined && tool.timeout_seconds !== undefined && check.timeout_seconds > tool.timeout_seconds) {
            problems.push(`${check.id} allows ${check.timeout_seconds}s, but ${check.tool} times out after ${tool.timeout_seconds}s`);
        }
    }
    if (check.id.startsWith("core.")) {
        problems.push(...genericityProblems(check.id, [check.title, check.purpose, check.expected.description, check.failure].join("\n")));
    }
    return problems;
}
