import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { checkstyleRuleDocument } from "../../generator-runtime.ts";
import { resolveSafePath } from "../../safe-path.ts";
import { createRegistry } from "../../schemas.ts";
import type { AnswerValue } from "../answers.ts";
import type { DecisionContext, HandlerRegistration } from "../gate.ts";
import { detectRuleCandidates, moduleOptionId, type RuleConvention } from "../providers/rules.ts";

function conventionDocument(item: RuleConvention) {
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

function apply(answer: AnswerValue, context: DecisionContext): readonly string[] {
  if (answer === "decline") return [];
  const found = detectRuleCandidates(context.projectRoot, true);
  const chosenModule = found.modules.find((item) => moduleOptionId(item) === answer);
  if (answer !== "adopt" && chosenModule === undefined) throw new Error(`Unknown rule option: ${String(answer)}.`);
  const files = answer === "adopt"
    ? [
      ...found.modules.map((item) => ({ path: item.rulePath, document: checkstyleRuleDocument(item) as unknown })),
      ...found.conventions.map((item) => ({ path: `.paved/rules/quality/${item.id}.yaml`, document: conventionDocument(item) as unknown })),
    ]
    : [{ path: chosenModule!.rulePath, document: checkstyleRuleDocument(chosenModule!) as unknown }];
  if (files.length === 0) return [];
  const registry = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]);
  for (const file of files) {
    const result = registry.validate(file.document);
    if (!result.valid) throw new Error(`${file.path} is invalid: ${result.errors.join("; ")}`);
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

export const rulesHandler: HandlerRegistration = {
  effect: "config-additive", apply, reject: (answer) => answer === "decline",
};
