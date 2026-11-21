import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.js";
import { resolveSafePath } from "./safe-path.js";
export const DEFAULT_MODELS_CONFIG = [
    "apiVersion: paved/v1",
    "kind: ModelPolicy",
    "roles:",
    "  explorer: [session]",
    "  implementer: [session]",
    "  reviewer: [session]",
    "  mechanical: [session]",
    "",
].join("\n");
function canonicalPolicy(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const document = value;
    if (document.kind === "ModelPolicy")
        return document;
    if (Object.keys(document).some((key) => key !== "roles") || document.roles === null ||
        typeof document.roles !== "object" || Array.isArray(document.roles))
        return undefined;
    const roles = document.roles;
    const supported = ["explorer", "implementer", "reviewer", "mechanical"];
    if (Object.keys(roles).some((key) => !supported.includes(key)))
        return undefined;
    const complete = {};
    for (const role of supported)
        complete[role] = roles[role] ?? ["session"];
    return { apiVersion: "paved/v1", kind: "ModelPolicy", roles: complete };
}
function validateLegacyRoles(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const document = value;
    if (document.apiVersion !== undefined || document.kind !== undefined || document.roles === null ||
        typeof document.roles !== "object" || Array.isArray(document.roles) ||
        Object.keys(document).some((key) => key !== "roles"))
        return false;
    const roles = document.roles;
    const supported = ["explorer", "implementer", "reviewer", "mechanical"];
    return Object.keys(roles).every((key) => supported.includes(key)) &&
        Object.values(roles).every((models) => Array.isArray(models) && models.length > 0 &&
            models.every((model) => typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(model)) &&
            new Set(models).size === models.length);
}
/** Validates canonical ModelPolicy documents and the established roles-only format. */
export function validateModelsConfig(projectRoot, registry) {
    let path;
    try {
        path = resolveSafePath(projectRoot, ".paved/models.yaml");
        if (!existsSync(path))
            return undefined;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile())
            return ".paved/models.yaml must be a regular file; existing state was left untouched.";
        const source = readFileSync(path, "utf8");
        const document = parse(source);
        if (validateLegacyRoles(document))
            return undefined;
        const canonical = canonicalPolicy(document);
        if (canonical === undefined)
            return ".paved/models.yaml is invalid: expected ModelPolicy roles.";
        if (registry === undefined) {
            const policy = canonical;
            const roles = policy.roles;
            const supported = ["explorer", "implementer", "reviewer", "mechanical"];
            if (supported.some((role) => !Array.isArray(roles[role]) || roles[role].length < 1 ||
                roles[role].length > 20 || roles[role].some((model) => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(model))) ||
                supported.some((role) => new Set(roles[role]).size !== roles[role].length)) {
                return ".paved/models.yaml is invalid: each role needs unique model ids.";
            }
            return undefined;
        }
        const result = registry.validate(canonical);
        return result.valid ? undefined : `.paved/models.yaml is invalid: ${result.errors.join("; ")}`;
    }
    catch (error) {
        return `.paved/models.yaml is invalid or unsafe: ${error instanceof Error ? error.message : "cannot read file"}`;
    }
}
/** Creates the conservative default only when no human-owned preferences exist. */
export function ensureModelsConfig(projectRoot, registry) {
    const directory = join(projectRoot, ".paved");
    const path = resolveSafePath(projectRoot, ".paved/models.yaml");
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(".paved/models.yaml must be a regular file; existing state was left untouched.");
        }
        const validation = validateModelsConfig(projectRoot, registry);
        if (validation !== undefined)
            throw new Error(validation);
        return false;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    mkdirSync(directory, { recursive: true });
    atomicWriteFileSync(path, DEFAULT_MODELS_CONFIG);
    const validation = validateModelsConfig(projectRoot, registry);
    if (validation !== undefined)
        throw new Error(validation);
    return true;
}
