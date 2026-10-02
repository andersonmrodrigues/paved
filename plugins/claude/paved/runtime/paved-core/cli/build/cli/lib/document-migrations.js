import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { loadMarkdown, loadYaml } from "./documents.js";
export const documentMigrations = [
    {
        id: "legacy-document-to-paved-v1",
        fromApiVersion: undefined,
        toApiVersion: "paved/v1",
        documentKinds: ["Project", "Lock", "Adapter", "CapabilityRegistry", "Rule", "Skill", "Workflow",
            "WorkflowRun", "Check", "Decision", "Tool", "ToolImplementation", "Evidence", "VerificationProfile",
            "Feature", "ContextDocument", "Overrides", "Generator", "GeneratedArtifact", "GardenerObservation",
            "GardenerProposal", "GardenerReviews", "CoreImprovementCandidate", "AgentIntegration"],
        description: "Adds the required paved/v1 API version to a legacy document.",
        appliesTo: (document) => document !== null && typeof document === "object" &&
            !Array.isArray(document) && !("apiVersion" in document),
        apply: (document) => ({ apiVersion: "paved/v1", ...document }),
    },
];
const directories = ["project", "rules", "skills", "workflows", "tools", "tool-implementations",
    "verification/checks"];
function walkFiles(directory, visit) {
    if (!existsSync(directory))
        return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory())
            walkFiles(path, visit);
        else
            visit(path);
    }
}
function apiVersionOf(document) {
    if (document !== null && typeof document === "object" && !Array.isArray(document)) {
        const value = document.apiVersion;
        return typeof value === "string" ? value : undefined;
    }
    return undefined;
}
function kindOf(document) {
    if (document !== null && typeof document === "object" && !Array.isArray(document)) {
        const value = document.kind;
        return typeof value === "string" ? value : undefined;
    }
    return undefined;
}
function candidates(document) {
    const version = apiVersionOf(document);
    const kind = kindOf(document);
    return documentMigrations.filter((migration) => migration.fromApiVersion === version &&
        (kind === undefined || migration.documentKinds.includes(kind)) &&
        migration.appliesTo(document));
}
function readDocument(path) {
    if (path.endsWith(".md")) {
        const markdown = loadMarkdown(path);
        return { document: markdown.frontmatter, markdown };
    }
    return { document: loadYaml(path), markdown: undefined };
}
function writeDocument(path, document, markdown) {
    if (markdown) {
        writeFileSync(path, `---\n${stringify(document).trimEnd()}\n---\n${markdown.body}`);
        return;
    }
    writeFileSync(path, stringify(document));
}
export function planDocumentMigrations(projectRoot, registry) {
    const migrations = [];
    const diagnostics = [];
    for (const directory of directories) {
        walkFiles(join(projectRoot, ".paved", directory), (full) => {
            if (!/\.(yaml|yml|md)$/.test(full) || full.endsWith("SKILL.md") || full.endsWith("WORKFLOW.md"))
                return;
            const path = relative(projectRoot, full).split(sep).join("/");
            try {
                const { document } = readDocument(full);
                if (registry.validate(document).valid)
                    return;
                const matches = candidates(document);
                if (matches.length === 1) {
                    const migration = matches[0];
                    migrations.push({ id: migration.id, path, toApiVersion: migration.toApiVersion,
                        ...(migration.fromApiVersion === undefined ? {} : { fromApiVersion: migration.fromApiVersion }) });
                    return;
                }
                diagnostics.push({
                    path,
                    message: matches.length === 0
                        ? "document has no known deterministic migration"
                        : "multiple deterministic migrations match this document",
                });
            }
            catch {
                diagnostics.push({ path, message: "document cannot be parsed under the candidate Core" });
            }
        });
    }
    return { migrations, diagnostics };
}
export function applyDocumentMigrations(projectRoot, planned, registry) {
    for (const item of planned) {
        const path = join(projectRoot, item.path);
        const { document, markdown } = readDocument(path);
        const migration = documentMigrations.find((candidate) => candidate.id === item.id);
        if (!migration || !migration.appliesTo(document))
            throw new Error(`Migration ${item.id} is no longer applicable to ${item.path}.`);
        const migrated = migration.apply(document);
        const validation = registry.validate(migrated);
        if (!validation.valid)
            throw new Error(`Migration ${item.id} produced an invalid document at ${item.path}.`);
        writeDocument(path, migrated, markdown);
    }
}
