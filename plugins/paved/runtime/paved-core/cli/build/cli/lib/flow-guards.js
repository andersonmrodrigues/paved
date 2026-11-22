import { existsSync } from "node:fs";
import { join } from "node:path";
import { globRegex } from "./adapters.js";
import { loadYaml } from "./documents.js";
import { createRegistry } from "./schemas.js";
export const DEFAULT_MAX_TRIVIAL_FILES = 5;
export class FlowPolicyError extends Error {
}
/** The project's `flow` overrides. An unreadable or invalid file fails closed rather than lifting the limits. */
export function loadFlowPolicy(projectRoot, coreRoot) {
    const path = join(projectRoot, ".paved/overrides/overrides.yaml");
    if (!existsSync(path))
        return { protectedPaths: [], maxTrivialFiles: DEFAULT_MAX_TRIVIAL_FILES };
    let document;
    try {
        document = loadYaml(path);
    }
    catch (error) {
        throw new FlowPolicyError(`.paved/overrides/overrides.yaml cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(document);
    if (!validation.valid)
        throw new FlowPolicyError(".paved/overrides/overrides.yaml does not match the Overrides schema.");
    const flow = document.flow;
    return { protectedPaths: flow?.protected_paths ?? [], maxTrivialFiles: flow?.max_trivial_files ?? DEFAULT_MAX_TRIVIAL_FILES };
}
/** Why the run's diff is too much for its lane, or undefined when it fits. */
export function flowViolation(run, files, policy) {
    const patterns = policy.protectedPaths.map(globRegex);
    const protectedFiles = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
    if (protectedFiles.length > 0) {
        return { reason: "protected-path", files: protectedFiles,
            message: `The change touches protected paths (${protectedFiles.slice(0, 10).join(", ")}${protectedFiles.length > 10 ? ", ..." : ""}).` };
    }
    if (run.classification?.lane === "trivial" && files.length > policy.maxTrivialFiles) {
        return { reason: "trivial-too-large", files,
            message: `A trivial run may change at most ${policy.maxTrivialFiles} files, and this one changed ${files.length}.` };
    }
    return undefined;
}
