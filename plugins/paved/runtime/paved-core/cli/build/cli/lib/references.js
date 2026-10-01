// Reference validation: every qualified id a document uses must name an artifact of the
// right kind that exists, in a namespace the document may depend on.
//
// Composable artifacts (rules, tools, skills, workflows, checks) are identified by
// `<namespace>.<path>`. The field a reference appears in fixes the kind it points to.
// See docs/concepts/references.md. Run after schema validation.
const KIND_OF_DOCUMENT = {
    Rule: "rule",
    Tool: "tool",
    ToolImplementation: "tool-implementation",
    Skill: "skill",
    Workflow: "workflow",
    Check: "check",
};
export const namespaceOf = (id) => id.split(".")[0] ?? "";
/** Namespace a document belongs to: its own id's, or `project` for project-only kinds. */
function ownerOf(document) {
    return KIND_OF_DOCUMENT[String(document["kind"])] !== undefined ? namespaceOf(String(document["id"])) : "project";
}
const fields = (value) => (value !== null && typeof value === "object" ? value : {});
const entries = (value) => (Array.isArray(value) ? value.map(fields) : []);
export function referencesIn(document) {
    const refs = [];
    const add = (kind, field, ids, optional = false) => {
        for (const id of Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]) {
            refs.push(optional ? { kind, id: String(id), field, optional } : { kind, id: String(id), field });
        }
    };
    switch (document["kind"]) {
        case "Skill": {
            const tools = fields(document["tools"]);
            const dependencies = fields(document["depends_on"]);
            add("tool", "tools.required", tools["required"]);
            add("tool", "tools.optional", tools["optional"], true);
            add("rule", "rules", document["rules"]);
            add("skill", "depends_on.required", dependencies["required"]);
            add("skill", "depends_on.optional", dependencies["optional"], true);
            add("skill", "deprecation.replaced_by", fields(document["deprecation"])["replaced_by"]);
            break;
        }
        case "Workflow":
            add("rule", "rules", document["rules"]);
            add("workflow", "deprecation.replaced_by", fields(document["deprecation"])["replaced_by"]);
            for (const phase of entries(document["phases"])) {
                const at = `phases.${String(phase["phase"])}`;
                const tools = fields(phase["tools"]);
                add("skill", `${at}.skills`, phase["skills"]);
                add("tool", `${at}.tools.required`, tools["required"]);
                add("tool", `${at}.tools.optional`, tools["optional"], true);
            }
            break;
        case "Rule":
            add("workflow", "applies_to.workflows", fields(document["applies_to"])["workflows"]);
            break;
        case "Evidence":
            add("workflow", "producer.workflow", fields(document["producer"])["workflow"]);
            add("skill", "producer.skills", fields(document["producer"])["skills"]);
            for (const rule of entries(document["rules"]))
                add("rule", "rules", rule["id"]);
            for (const check of entries(document["checks"])) {
                add("check", `checks.${String(check["id"])}.check`, check["check"]);
                add("tool", `checks.${String(check["id"])}.tool`, fields(check["tool"])["id"]);
            }
            break;
        case "VerificationProfile":
            add("check", "checks", document["checks"]);
            break;
        case "Check":
            add("tool", "tool", document["tool"]);
            break;
        case "ToolImplementation":
            add("tool", "tool", document["tool"]);
            break;
        case "Overrides":
            for (const [list, kind] of [["rules", "rule"], ["skills", "skill"], ["workflows", "workflow"]]) {
                for (const entry of entries(document[list]))
                    add(kind, `${list}.target`, entry["target"]);
            }
            for (const entry of entries(document["tools"])) {
                add("tool", "tools.target", entry["target"]);
                add("tool-implementation", "tools.implementation", entry["implementation"]);
            }
            break;
    }
    return refs;
}
/** Ids of every rule, tool, skill, workflow and check among the documents, by kind. */
export function indexArtifacts(documents) {
    const index = new Map();
    for (const { document } of documents) {
        const kind = KIND_OF_DOCUMENT[String(document["kind"])];
        if (kind === undefined)
            continue;
        if (!index.has(kind))
            index.set(kind, new Set());
        index.get(kind).add(String(document["id"]));
    }
    return index;
}
/**
 * Problems with the references in `documents`, resolved against `index` (usually the
 * effective set: Core, selected adapters and project content).
 *
 * Optional references (skill `tools.optional`, `depends_on.optional`) may be absent.
 * Visibility follows the dependency direction: Core content references only Core; an
 * adapter references Core and itself; a project references anything. Overrides may
 * only target inherited (Core or adapter) content.
 */
export function resolveReferences(documents, index) {
    const problems = [];
    for (const { label, document } of documents) {
        const owner = ownerOf(document);
        for (const ref of referencesIn(document)) {
            const target = namespaceOf(ref.id);
            if (!ref.optional && !index.get(ref.kind)?.has(ref.id)) {
                problems.push(`${label}: ${ref.field} references unknown ${ref.kind} "${ref.id}"`);
            }
            if (owner !== "project" && target !== "core" && target !== owner) {
                problems.push(`${label}: ${ref.field} references "${ref.id}", but ${owner} content may only reference core or ${owner}`);
            }
            if (document["kind"] === "Overrides" && target === "project" && ref.field !== "tools.implementation") {
                problems.push(`${label}: ${ref.field} targets project content "${ref.id}"; edit it directly instead of overriding it`);
            }
        }
    }
    return problems;
}
