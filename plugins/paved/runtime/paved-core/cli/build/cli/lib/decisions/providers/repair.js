import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_DRIFT_CODES, inspectConsumer } from "../../consumer-state.js";
const REPAIRABLE = new Set([
    ...CONTEXT_DRIFT_CODES, "PAVED_GENERATOR_INPUTS_STALE", "PAVED_GENERATED_OUTPUT_MISSING",
]);
export const repairProvider = (context) => {
    const findings = inspectConsumer({ projectRoot: context.projectRoot, coreRoot: context.coreRoot, ...(context.sourceRoot === undefined ? {} : { sourceRoot: context.sourceRoot }) }).diagnostics
        .filter((item) => REPAIRABLE.has(item.code));
    if (findings.length === 0)
        return [];
    const evidencePath = ".paved/generated/state/last-run.json";
    const evidenceFile = join(context.projectRoot, evidencePath);
    if (!existsSync(evidenceFile))
        return [];
    // The generator state changes with every regeneration, so a later repair is a new
    // decision while the findings that prompt this one may grow without replacing it.
    const evidence = [{
            type: "file", location: evidencePath,
            sha256: createHash("sha256").update(readFileSync(evidenceFile)).digest("hex"),
        }];
    return [{
            scope: "project",
            question: "Should Paved regenerate the affected project context files?",
            reason: `Doctor found: ${findings.map((item) => item.message).join(" ")} Applying this repair reruns project context generators and can change generated files.`,
            options: [
                { id: "apply", label: "Regenerate affected context", description: "Run the project context generators again.", consequence: "Generated context files and generator state may change; human edits to generated files are kept as proposals." },
                { id: "skip", label: "Skip", description: "Leave generated files unchanged.", consequence: "The reported findings remain until handled later." },
            ],
            recommended: "apply", evidence, required: false,
            requiredAnswer: { type: "single-choice" }, effect: "context-regenerating",
            // The question is the same however many cited files changed: the handler regenerates
            // every generator. The findings stay in the reason, not in the identity.
            handler: "repair.apply", candidates: ["repair:project-context"],
        }];
};
