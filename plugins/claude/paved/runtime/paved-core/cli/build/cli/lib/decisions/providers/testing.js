import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTestingTool } from "../../test-runner.js";
import { detectCheckCandidates } from "./verification.js";
function optionId(id) {
    const slug = id.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}
export const testingProvider = (context) => {
    const resolution = resolveTestingTool(context.projectRoot, context.coreRoot);
    if (resolution.status !== "ambiguous")
        return [];
    const manifest = join(context.projectRoot, ".paved/manifest.yaml");
    if (!existsSync(manifest))
        return [];
    const evidence = [{
            type: "file",
            location: ".paved/manifest.yaml",
            sha256: createHash("sha256").update(readFileSync(manifest)).digest("hex"),
        }];
    return [{
            scope: "project",
            question: "Which authorized testing Tool should run for this project?",
            reason: "Several declared testing Tools have authorized implementations; the project must select one.",
            options: resolution.candidates.map((id) => ({
                id: optionId(id), label: id,
                description: `Use the declared ${id} Tool.`,
                consequence: `Paved test will execute ${id}.`,
            })),
            evidence, required: true, requiredAnswer: { type: "single-choice" },
            effect: "record-only", handler: "testing.select",
            candidates: resolution.candidates,
        }];
};
export const TESTING_TOOL_PATH = ".paved/tools/testing.yaml";
export function testingOptionId(candidate) {
    return `test-${optionId(`${candidate.scope}:${candidate.id}`)}`;
}
/** Detected test commands that could become the governed testing Tool. */
export function detectTestingCandidates(projectRoot) {
    return detectCheckCandidates(projectRoot).filter((item) => item.id.endsWith("-test"));
}
/**
 * Development workflows need exactly one governed testing Tool. When the project has none,
 * init asks which detected test command it is, instead of leaving workflows unavailable.
 */
export const testingAdoptProvider = (context) => {
    if (existsSync(join(context.projectRoot, TESTING_TOOL_PATH)))
        return [];
    if (resolveTestingTool(context.projectRoot, context.coreRoot).status === "suite")
        return [];
    if (resolveTestingTool(context.projectRoot, context.coreRoot).status !== "unavailable")
        return [];
    const candidates = detectTestingCandidates(context.projectRoot);
    if (candidates.length === 0)
        return [];
    const where = (item) => (item.scope === "." ? "the repository root" : item.scope);
    const evidence = [...new Map(candidates.map((item) => [item.source.location, item.source])).values()]
        .sort((a, b) => a.location.localeCompare(b.location, "en"));
    return [{
            scope: "project",
            question: "Which detected test commands should Paved run when a workflow tests a change?",
            reason: "feature, fix, refactor, implement and test run the selected governed testing commands. "
                + "Without it those commands stay unavailable.",
            options: [
                ...(candidates.length > 1 ? [{
                        id: "all", label: "All detected module tests",
                        description: candidates.map((item) => `${item.label} in ${where(item)}`).join(", "),
                        consequence: "Workflows test every selected module.",
                    }] : []),
                ...candidates.map((item) => ({
                    id: testingOptionId(item),
                    label: `${item.label} in ${where(item)}`,
                    description: `Run ${item.label} from ${where(item)}.`,
                    consequence: `Workflows test changes with ${item.label} in ${where(item)}.`,
                })),
                {
                    id: "none", label: "None",
                    description: "Declare no testing command now.",
                    consequence: "feature, fix, refactor, implement and test stay unavailable.",
                },
            ],
            recommended: candidates.length > 1 ? "all" : testingOptionId(candidates[0]),
            evidence,
            required: true,
            requiredAnswer: { type: "single-choice" },
            effect: "config-additive",
            handler: "testing.adopt",
            candidates: candidates.map((item) => `testing:${item.scope}:${item.id}`),
        }];
};
