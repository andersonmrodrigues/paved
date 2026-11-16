import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { globRegex } from "./adapters.js";
import { loadYaml } from "./documents.js";
function walk(dir, visit) {
    if (!existsSync(dir))
        return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
            walk(path, visit);
        else if (entry.isFile() && entry.name.endsWith(".yaml") && !entry.name.endsWith(".paved.yaml"))
            visit(path);
    }
}
function collect(root, dir, origin, into) {
    walk(join(root, dir), (path) => {
        let doc;
        // An unreadable document is reported by status and doctor; here it simply matches nothing.
        try {
            doc = loadYaml(path);
        }
        catch {
            return;
        }
        if (doc?.kind !== "Rule" || typeof doc.id !== "string" || typeof doc.title !== "string" || typeof doc.rule !== "string")
            return;
        const paths = doc.applies_to?.paths;
        into.push({
            id: doc.id, origin, path: relative(root, path).split(sep).join("/"), title: doc.title, rule: doc.rule,
            ...(Array.isArray(paths) && paths.every((item) => typeof item === "string") ? { paths: paths } : {}),
        });
    });
}
/** Core rules, the consumer's project rules and, when asked, the rule proposals awaiting adoption. */
export function loadRuleCatalog(input) {
    const rules = [];
    collect(input.coreRoot, "core/rules", "core", rules);
    collect(input.projectRoot, ".paved/rules", "project", rules);
    if (input.proposals)
        collect(input.projectRoot, ".paved/generated/proposals/rules", "proposal", rules);
    return rules;
}
/** Whether a rule constrains any of the files; a rule without path selectors applies everywhere. */
export function ruleCovers(rule, files) {
    if (rule.paths === undefined)
        return true;
    const patterns = rule.paths.map(globRegex);
    return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}
