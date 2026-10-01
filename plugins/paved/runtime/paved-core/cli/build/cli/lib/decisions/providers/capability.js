import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { capabilityCandidates, detectAdapters, loadAdapters, resolveAdapters, resolveCapabilities, } from "../../adapters.js";
import { discoverSources } from "../../generator-runtime.js";
export { answeredProviders } from "../capability-answers.js";
export const capabilityHandler = { effect: "record-only", apply: () => [] };
export const capabilityProvider = (context) => {
    const manifestPath = join(context.projectRoot, ".paved/manifest.yaml");
    const manifest = existsSync(manifestPath)
        ? parse(readFileSync(manifestPath, "utf8"))
        : undefined;
    const sources = discoverSources(context.projectRoot);
    const sourceByPath = new Map(sources.map((source) => [source.path, source]));
    const detected = detectAdapters(context.projectRoot, loadAdapters(context.coreRoot), sources);
    const detectedSelections = detected.filter((item) => item.confidence === "strong")
        .map((item) => ({ id: item.adapter.id, version: `^${item.adapter.version}` }));
    const pkg = JSON.parse(readFileSync(join(context.coreRoot, "package.json"), "utf8"));
    const resolved = resolveAdapters(detected, manifest?.adapters ?? detectedSelections, pkg.version);
    if (resolved.diagnostics.length > 0)
        return [];
    const resolutions = resolveCapabilities(resolved.adapters, manifest?.capability_providers);
    return Object.entries(resolutions).flatMap(([id, resolution]) => resolution.ambiguousScopes.flatMap((scope) => {
        const choices = capabilityCandidates(id, resolved.adapters, scope);
        if (choices.length < 2)
            return [];
        const evidence = [...new Set(choices.flatMap((choice) => choice.evidence))]
            .flatMap((path) => {
            const source = sourceByPath.get(path);
            return source === undefined ? [] : [{ type: "file", location: path, sha256: source.sha256 }];
        });
        const options = choices.map((choice) => ({
            id: choice.adapter.id.replace("/", "-"), label: choice.adapter.id,
            description: `Use ${choice.adapter.id} for ${id} in ${scope}.`,
            consequence: `Evidence for ${id} in ${scope} comes from ${choice.adapter.id}.`,
        }));
        return [{
                scope: "project",
                question: `Which provider should supply ${id} in ${scope}?`,
                reason: `More than one detected adapter can provide ${id} in ${scope}.`,
                options, evidence, required: true,
                requiredAnswer: { type: "single-choice" },
                effect: "record-only", handler: "capability.select",
                candidates: [`capability:${id}@${scope}`, ...choices.map((choice) => choice.adapter.id)],
            }];
    }));
};
