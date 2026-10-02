import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFileSync } from "../../atomic-write.js";
import { checkstyleRuleDocument } from "../../generator-runtime.js";
import { resolveSafePath } from "../../safe-path.js";
import { createRegistry } from "../../schemas.js";
import { detectRuleCandidates, moduleOptionId } from "../providers/rules.js";
function conventionDocument(item) {
    return {
        apiVersion: "paved/v1", kind: "Rule", id: `project.quality.${item.id}`,
        title: `Follow the ${item.id} configuration`,
        rationale: `The project adopted its observed ${item.source.path} convention as a rule.`,
        applies_to: { paths: item.id === "checkstyle" ? ["**/*.java"] : ["**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx"] },
        rule: `Changes covered by ${item.source.path} comply with that configuration.`,
        enforcement: { mechanism: "agent", layer: "rule" },
        severity: "warning",
        verification: `Record evidence that changed files comply with ${item.source.path}.`,
        references: [item.source.path],
    };
}
function apply(answer, context) {
    if (answer === "decline")
        return [];
    const found = detectRuleCandidates(context.projectRoot, true);
    const chosenModule = found.modules.find((item) => moduleOptionId(item) === answer);
    if (answer !== "adopt" && chosenModule === undefined)
        throw new Error(`Unknown rule option: ${String(answer)}.`);
    const files = answer === "adopt"
        ? [
            ...found.modules.map((item) => ({ path: item.rulePath, document: checkstyleRuleDocument(item) })),
            ...found.conventions.map((item) => ({ path: `.paved/rules/quality/${item.id}.yaml`, document: conventionDocument(item) })),
        ]
        : [{ path: chosenModule.rulePath, document: checkstyleRuleDocument(chosenModule) }];
    if (files.length === 0)
        return [];
    const registry = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]);
    for (const file of files) {
        const result = registry.validate(file.document);
        if (!result.valid)
            throw new Error(`${file.path} is invalid: ${result.errors.join("; ")}`);
        const path = resolveSafePath(context.projectRoot, file.path);
        if (existsSync(path) && JSON.stringify(parse(readFileSync(path, "utf8"))) !== JSON.stringify(file.document)) {
            throw new Error(`Refusing to overwrite an existing Paved document: ${file.path}`);
        }
    }
    for (const file of files) {
        const path = resolveSafePath(context.projectRoot, file.path);
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, stringify(file.document));
    }
    return files.map((file) => file.path);
}
export const rulesHandler = {
    effect: "config-additive", apply, reject: (answer) => answer === "decline",
};
