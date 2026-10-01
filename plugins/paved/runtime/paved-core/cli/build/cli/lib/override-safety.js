import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "./documents.js";
import { hashLocalFile } from "./local-core.js";
import { createRegistry } from "./schemas.js";
import { createDiagnostic } from "../result.js";
function targetIndex(coreRoot, selectedAdapters) {
    const roots = ["core/rules", "core/skills", "core/workflows", "core/tools", "core/tool-implementations",
        ...selectedAdapters.map((id) => `adapters/${id}`)];
    const targets = new Map();
    function walk(path) {
        const full = join(coreRoot, path);
        if (!existsSync(full))
            return;
        for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
            const child = `${path}/${entry.name}`;
            if (entry.isDirectory())
                walk(child);
            else if (entry.isFile() && entry.name.endsWith(".yaml")) {
                const doc = loadYaml(join(coreRoot, child));
                if (typeof doc?.id === "string" && typeof doc.kind === "string") {
                    targets.set(`${doc.kind}:${doc.id}`, { kind: doc.kind, id: doc.id, path: child,
                        ...(doc.overridable === undefined ? {} : { overridable: doc.overridable }) });
                }
            }
        }
    }
    for (const root of roots)
        walk(root);
    return targets;
}
export function inspectOverrides(projectRoot, coreRoot, selectedAdapters) {
    const path = join(projectRoot, ".paved/overrides/overrides.yaml");
    if (!existsSync(path))
        return [];
    const diagnostics = [];
    let document;
    try {
        document = loadYaml(path);
        const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(document);
        if (!validation.valid)
            throw new Error(validation.errors.join("; "));
    }
    catch {
        return [createDiagnostic({ severity: "error", category: "config", code: "PAVED_OVERRIDES_INVALID", component: "consumer.overrides",
                message: "Overrides cannot be parsed or do not match the Overrides schema.", remediation: "Fix .paved/overrides/overrides.yaml before updating." })];
    }
    const targets = targetIndex(coreRoot, selectedAdapters);
    const kinds = { rules: "Rule", skills: "Skill", workflows: "Workflow", tools: "Tool" };
    const seen = new Set();
    for (const [list, kind] of Object.entries(kinds)) {
        for (const override of document[list] ?? []) {
            const key = `${kind}:${override.target}`;
            const target = targets.get(key);
            const problem = (code, message, category = "conflict") => diagnostics.push(createDiagnostic({
                severity: "error", category, code, component: "consumer.overrides", message,
                remediation: "Review the override against the selected inherited content; do not retarget it automatically.",
            }));
            if (seen.has(key))
                problem("PAVED_OVERRIDE_DUPLICATE", `Multiple overrides target ${override.target}.`);
            seen.add(key);
            if (!target) {
                problem("PAVED_OVERRIDE_TARGET_MISSING", `Override target ${override.target} is unavailable or has the wrong kind.`);
                continue;
            }
            if (kind === "Rule" && target.overridable === false)
                problem("PAVED_OVERRIDE_TARGET_PROTECTED", `Rule ${override.target} cannot be overridden.`);
            if (override.target_sha256 && override.target_sha256 !== hashLocalFile(coreRoot, target.path)) {
                problem("PAVED_OVERRIDE_TARGET_CHANGED", `Override target ${override.target} changed and requires review.`);
            }
            if (!override.target_sha256)
                diagnostics.push(createDiagnostic({ severity: "warning", category: "findings",
                    code: "PAVED_OVERRIDE_DIGEST_MISSING", component: "consumer.overrides",
                    message: `Override ${override.target} has no target digest, so drift cannot be checked.`,
                    remediation: "Record the current target SHA-256 after reviewing the override." }));
            if (override.implementation && !targets.has(`ToolImplementation:${override.implementation}`)) {
                problem("PAVED_OVERRIDE_IMPLEMENTATION_MISSING", `Selected implementation ${override.implementation} is unavailable.`);
            }
        }
    }
    return diagnostics;
}
