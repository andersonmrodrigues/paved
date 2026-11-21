import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import { loadAdapters } from "./adapters.js";
import { compatible } from "./tools.js";
const runDirectory = ".paved/generated/runs";
const archiveDirectory = ".paved/archive/v2/generated/runs";
export const V2_TO_V3_MIGRATION_READY = "core/migrations/v2-to-v3.ready";
export const V2_TO_V3_MIGRATION_READY_CONTENT = "v3-routing-and-gates-verified";
function majorOf(version) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return match ? Number(match[1]) : undefined;
}
function migrationIsReady(coreRoot) {
    const marker = join(coreRoot, V2_TO_V3_MIGRATION_READY);
    try {
        const stat = lstatSync(marker);
        return stat.isFile() && !stat.isSymbolicLink()
            && readFileSync(marker, "utf8").trim() === V2_TO_V3_MIGRATION_READY_CONTENT;
    }
    catch {
        return false;
    }
}
function assertNoSymlinkPath(root, path) {
    let current = root;
    for (const segment of path.split(/[\\/]+/).filter(Boolean)) {
        current = join(current, segment);
        if (!existsSync(current))
            break;
        if (lstatSync(current).isSymbolicLink()) {
            throw new Error(`Cannot migrate through symbolic link ${relative(root, current).split(sep).join("/")}.`);
        }
    }
}
function filesUnder(root, directory) {
    const absolute = join(root, directory);
    if (!existsSync(absolute))
        return [];
    assertNoSymlinkPath(root, directory);
    const files = [];
    function walk(current) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const path = join(current, entry.name);
            if (entry.isSymbolicLink())
                throw new Error(`Cannot archive legacy runs through symbolic links: ${relative(root, path).split(sep).join("/")}.`);
            if (entry.isDirectory())
                walk(path);
            else if (entry.isFile())
                files.push(relative(absolute, path).split(sep).join("/"));
            else
                throw new Error(`Cannot archive unsupported legacy run entry: ${relative(root, path).split(sep).join("/")}.`);
        }
    }
    walk(absolute);
    return files.sort();
}
function manifestCoreRange(projectRoot) {
    const path = join(projectRoot, ".paved/manifest.yaml");
    if (!existsSync(path))
        throw new Error("Cannot migrate Core versions without .paved/manifest.yaml.");
    const document = parseDocument(readFileSync(path, "utf8"));
    if (document.errors.length > 0)
        throw new Error("Cannot migrate Core versions because .paved/manifest.yaml is invalid.");
    const value = document.getIn(["paved", "core"]);
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("Cannot migrate Core versions because .paved/manifest.yaml has no paved.core range.");
    }
    return value;
}
function plannedAdapterRangeUpdates(projectRoot, coreRoot) {
    const path = join(projectRoot, ".paved/manifest.yaml");
    const document = parseDocument(readFileSync(path, "utf8"));
    const selections = document.toJSON().adapters;
    if (selections === undefined)
        return [];
    if (!Array.isArray(selections))
        throw new Error("Cannot migrate adapter ranges because manifest.adapters is invalid.");
    const bundled = new Map(loadAdapters(coreRoot).map((adapter) => [adapter.id, adapter]));
    const grouped = new Map();
    for (const selection of selections) {
        if (selection === null || typeof selection !== "object"
            || typeof selection.id !== "string" || typeof selection.version !== "string") {
            throw new Error("Cannot migrate adapter ranges because manifest.adapters is invalid.");
        }
        const adapterSelections = grouped.get(selection.id) ?? [];
        adapterSelections.push({ id: selection.id, version: selection.version });
        grouped.set(selection.id, adapterSelections);
    }
    return [...grouped].flatMap(([id, adapterSelections]) => {
        const adapter = bundled.get(id);
        if (!adapter)
            return [];
        if (!adapterSelections.some((selection) => !compatible(adapter.version, selection.version)))
            return [];
        if (adapterSelections.length !== 1) {
            throw new Error(`Cannot migrate duplicate adapter selection ${id}; remove duplicate entries first.`);
        }
        const [selection] = adapterSelections;
        if (!selection)
            throw new Error(`Cannot migrate adapter selection ${id}.`);
        return [{
                id,
                previousRange: selection.version,
                nextRange: `^${adapter.version}`,
            }];
    });
}
export function planV2ToV3Migration(projectRoot, fromVersion, toVersion, coreRoot) {
    if (majorOf(fromVersion) !== 2 || majorOf(toVersion) !== 3 || !migrationIsReady(coreRoot))
        return undefined;
    const previousCoreRange = manifestCoreRange(projectRoot);
    const archivedRunFiles = filesUnder(projectRoot, runDirectory).map((path) => {
        const source = join(projectRoot, runDirectory, path);
        const targetPath = join(archiveDirectory, path);
        const target = join(projectRoot, targetPath);
        assertNoSymlinkPath(projectRoot, targetPath);
        if (existsSync(target)) {
            const targetStat = lstatSync(target);
            if (!targetStat.isFile() || !readFileSync(source).equals(readFileSync(target))) {
                throw new Error(`Archive conflict for legacy run ${targetPath}.`);
            }
        }
        return targetPath.split(sep).join("/");
    });
    return {
        fromVersion,
        toVersion,
        previousCoreRange,
        nextCoreRange: `^${toVersion}`,
        adapterRangeUpdates: plannedAdapterRangeUpdates(projectRoot, coreRoot),
        archivedRunFiles,
    };
}
export function applyV2ToV3Migration(projectRoot, plan) {
    const currentRange = manifestCoreRange(projectRoot);
    if (currentRange !== plan.previousCoreRange) {
        throw new Error("The project Core range changed after the v2 to v3 migration was planned.");
    }
    const manifestPath = join(projectRoot, ".paved/manifest.yaml");
    const manifest = parseDocument(readFileSync(manifestPath, "utf8"));
    const selections = manifest.toJSON().adapters;
    if (plan.adapterRangeUpdates.length > 0 && !Array.isArray(selections)) {
        throw new Error("The project adapter selections changed after the v2 to v3 migration was planned.");
    }
    for (const update of plan.adapterRangeUpdates) {
        const matches = selections
            .map((selection, index) => ({ selection, index }))
            .filter(({ selection }) => selection.id === update.id);
        const match = matches[0];
        if (matches.length !== 1 || !match || match.selection.version !== update.previousRange) {
            throw new Error(`The project adapter range for ${update.id} changed after the v2 to v3 migration was planned.`);
        }
        manifest.setIn(["adapters", match.index, "version"], update.nextRange);
    }
    const actualFiles = filesUnder(projectRoot, runDirectory).map((path) => join(archiveDirectory, path).split(sep).join("/")).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify([...plan.archivedRunFiles].sort())) {
        throw new Error("Legacy run records changed after the v2 to v3 migration was planned.");
    }
    for (const archivedPath of plan.archivedRunFiles) {
        const source = join(projectRoot, runDirectory, relative(archiveDirectory, archivedPath));
        const target = join(projectRoot, archivedPath);
        assertNoSymlinkPath(projectRoot, archivedPath);
        mkdirSync(join(target, ".."), { recursive: true });
        if (!existsSync(target))
            copyFileSync(source, target);
        if (!readFileSync(source).equals(readFileSync(target))) {
            throw new Error(`Could not verify the archived legacy run ${archivedPath}.`);
        }
    }
    manifest.setIn(["paved", "core"], plan.nextCoreRange);
    writeFileSync(manifestPath, stringify(manifest));
    if (plan.archivedRunFiles.length > 0) {
        for (const archivedPath of plan.archivedRunFiles) {
            const source = join(projectRoot, runDirectory, relative(archiveDirectory, archivedPath));
            const target = join(projectRoot, archivedPath);
            if (!readFileSync(source).equals(readFileSync(target))) {
                throw new Error(`Legacy run verification failed before cleanup: ${archivedPath}.`);
            }
        }
        rmSync(join(projectRoot, runDirectory), { recursive: true });
    }
}
