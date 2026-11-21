import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "./documents.js";
import { resolveSafePath } from "./safe-path.js";
import { createRegistry } from "./schemas.js";
export class ReviewPolicyError extends Error {
}
export function loadReviewSensitivePatterns(projectRoot, coreRoot) {
    let path;
    try {
        path = resolveSafePath(projectRoot, ".paved/review.yaml");
    }
    catch {
        throw new ReviewPolicyError("The project review policy is invalid or unsafe.");
    }
    if (!existsSync(path))
        return [];
    let policy;
    try {
        policy = loadYaml(path);
    }
    catch {
        throw new ReviewPolicyError("The project review policy is invalid or unsafe.");
    }
    const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(policy);
    if (!validation.valid || policy?.kind !== "ReviewPolicy") {
        throw new ReviewPolicyError("The project review policy is invalid or unsafe.");
    }
    return policy.sensitive_paths;
}
