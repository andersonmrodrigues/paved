import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { globRegex } from "../lib/adapters.js";
import { loadYaml } from "../lib/documents.js";
import { loadRuleCatalog, ruleCovers } from "../lib/rule-catalog.js";
import { resolveSafePath } from "../lib/safe-path.js";
import { createDiagnostic, createResult } from "../result.js";
import { diagnoseQuick } from "../lib/doctor-quick.js";
import { generateHandler } from "./generate.js";
const CONTEXT_GENERATORS = {
    architecture: "project-context/architecture",
    domain: "project-context/domain",
    product: "project-context/product",
    integrations: "project-context/integrations",
    "feature-map": "project-context/feature-map",
};
const OTHER_GENERATORS = new Set(["rules", "skills", "tools", "verification"]);
function refreshHandler(invocation) {
    if (invocation.selectors.length !== 1 || invocation.flags.budget !== undefined) {
        return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_CONTEXT_REFRESH_USAGE", component: "context",
                    message: "Use context refresh with optional --areas <area,...>; --budget applies only to retrieval.",
                })] });
    }
    const requested = invocation.flags.areas;
    let areas = requested;
    if (areas.length === 0) {
        const diagnosis = diagnoseQuick({
            projectRoot: invocation.paths.projectRoot,
            sourceRoot: invocation.paths.sourceRoot,
            coreRoot: invocation.paths.coreRoot,
        });
        if (diagnosis.context === "unavailable") {
            return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                        severity: "error", category: "findings", code: "PAVED_CONTEXT_REFRESH_STATE_UNKNOWN", component: "context",
                        message: "Paved cannot determine stale context areas from the available generation evidence.",
                        remediation: "Name the areas to refresh explicitly with --areas, or run paved generate and resolve its diagnostics.",
                    })] });
        }
        areas = diagnosis.staleGenerators;
    }
    const generators = areas.map((area) => CONTEXT_GENERATORS[area] ?? (OTHER_GENERATORS.has(area) ? area : area.includes("/") ? area : undefined));
    const unknown = areas.filter((_area, index) => generators[index] === undefined);
    if (unknown.length > 0) {
        return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_CONTEXT_AREA_UNKNOWN", component: "context",
                    message: `Unknown context area${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
                    remediation: "Use architecture, domain, product, integrations, feature-map, rules, skills, tools, verification, or a full generator id.",
                })] });
    }
    if (generators.length === 0) {
        return createResult({ command: "context", status: "success", data: {
                areas: [], refreshed: false, changedFiles: [], message: "No stale context areas were detected.",
            } });
    }
    const generated = generateHandler({
        ...invocation,
        command: "generate",
        selectors: [...new Set(generators)],
    });
    const generation = generated.data;
    const changedFiles = [...new Set(generation?.executions?.flatMap((execution) => execution.changedOutputs ?? []) ?? [])]
        .sort((a, b) => a.localeCompare(b, "en"));
    return createResult({
        command: "context",
        status: generated.status,
        data: {
            areas,
            generation: generated.data,
            changedFiles: generation?.dryRun === true ? [] : changedFiles,
            ...(generation?.dryRun === true ? { wouldChangeFiles: changedFiles } : {}),
        },
        diagnostics: generated.diagnostics,
    });
}
export function contextHandler(invocation) {
    const { projectRoot, coreRoot } = invocation.paths;
    const query = invocation.selectors[0];
    if (query === "refresh") {
        if (!existsSync(resolveSafePath(projectRoot, ".paved/manifest.yaml"))) {
            return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                        severity: "error", category: "config", code: "PAVED_CONTEXT_UNINITIALIZED",
                        component: "context", message: "Paved is not initialized in this repository.",
                    })] });
        }
        return refreshHandler(invocation);
    }
    if (invocation.flags.areas.length > 0) {
        return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_CONTEXT_REFRESH_USAGE", component: "context",
                    message: "--areas is supported only by context refresh.",
                })] });
    }
    if (invocation.selectors.length !== 1 || !query?.trim()) {
        return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_CONTEXT_QUERY_REQUIRED",
                    component: "context", message: "Provide exactly one topic or project-relative path.",
                })] });
    }
    if (!existsSync(resolveSafePath(projectRoot, ".paved/manifest.yaml"))) {
        return createResult({ command: "context", status: "failed", diagnostics: [createDiagnostic({
                    severity: "error", category: "config", code: "PAVED_CONTEXT_UNINITIALIZED",
                    component: "context", message: "Paved is not initialized in this repository.",
                })] });
    }
    const features = [];
    const projectRules = [];
    const coreRules = [];
    const relatedPaths = [];
    const topic = query;
    const lower = topic.toLowerCase();
    const root = resolveSafePath(projectRoot, ".paved/project/feature-map");
    function walk(dir) {
        if (!existsSync(dir))
            return;
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
            const path = join(dir, entry.name);
            if (entry.isDirectory())
                walk(path);
            else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
                let feature;
                try {
                    feature = loadYaml(path);
                }
                catch {
                    continue;
                }
                if (feature?.kind !== "Feature" || typeof feature.id !== "string" ||
                    typeof feature.name !== "string" || typeof feature.summary !== "string")
                    continue;
                const paths = Array.isArray(feature.code?.paths) ? feature.code.paths.filter((value) => typeof value === "string") : [];
                if (![feature.id, feature.name, feature.summary].some((value) => value.toLowerCase().includes(lower)) &&
                    !paths.some((pattern) => globRegex(pattern).test(topic)))
                    continue;
                relatedPaths.push(...paths);
                features.push(`Feature ${feature.id}: ${feature.name}\n${feature.summary}\nPaths: ${paths.join(", ")}\nSource: ${relative(projectRoot, path).split(sep).join("/")}`);
            }
        }
    }
    walk(root);
    resolveSafePath(projectRoot, ".paved/rules");
    const rules = loadRuleCatalog({ projectRoot, coreRoot }).sort((a, b) => Number(b.origin === "project") - Number(a.origin === "project") ||
        Number(b.paths !== undefined) - Number(a.paths !== undefined));
    for (const rule of rules) {
        const textMatches = `${rule.id} ${rule.title} ${rule.rule}`.toLowerCase().includes(lower);
        if (!textMatches && !ruleCovers(rule, [topic, ...relatedPaths]))
            continue;
        (rule.origin === "project" ? projectRules : coreRules).push(`Rule ${rule.id}: ${rule.title}\n${rule.rule}\nSource: ${rule.path} (${rule.origin})`);
    }
    const matches = [...projectRules, ...features, ...coreRules];
    const budget = invocation.flags.budget ?? 1500;
    const selected = [];
    let bytes = 0;
    for (const match of matches) {
        const size = Buffer.byteLength(match, "utf8") + (selected.length ? 2 : 0);
        if (bytes + size > budget)
            break;
        selected.push(match);
        bytes += size;
    }
    return createResult({ command: "context", status: "success", data: {
            context: selected.join("\n\n"), truncated: selected.length < matches.length, matched: matches.length,
            budget, budgetUnit: "utf8-bytes",
        } });
}
