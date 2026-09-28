import { existsSync } from "node:fs";
import { join } from "node:path";
import { discoverSources } from "../../generator-runtime.ts";
import type { Source } from "../../generator-runtime.ts";
import type { DecisionProvider } from "../gate.ts";

const CONVENTIONS = [
  { id: "checkstyle", match: /(^|\/)checkstyle[^/]*\.xml$/ },
  { id: "eslint", match: /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/ },
] as const;

export interface RuleConvention { readonly id: "checkstyle" | "eslint"; readonly source: Source }

export function detectRuleConventions(projectRoot: string, includeExisting = false): RuleConvention[] {
  const sources = discoverSources(projectRoot);
  return CONVENTIONS.flatMap((convention) => {
    const rulePath = join(projectRoot, `.paved/rules/quality/${convention.id}.yaml`);
    if (!includeExisting && existsSync(rulePath)) return [];
    const source = sources.find((item) => convention.match.test(item.path));
    return source === undefined ? [] : [{ id: convention.id, source }];
  });
}

export const rulesProvider: DecisionProvider = (context) => {
  const found = detectRuleConventions(context.projectRoot);
  if (found.length === 0) return [];
  const names = found.map((item) => item.id).join(", ");
  return [{
    scope: "project",
    question: `Should the observed ${names} convention${found.length === 1 ? "" : "s"} become Paved project rules?`,
    reason: `Paved observed ${found.map((item) => item.source.path).join(", ")} in this repository. A project answer is required before these conventions become rules.`,
    options: [
      {
        id: "adopt", label: "Adopt as project rules",
        description: `Create a Paved rule for ${names}.`,
        consequence: "Reviews and workflows can cite the adopted rules.",
      },
      {
        id: "decline", label: "Leave observed",
        description: "Keep these configurations as repository evidence only.",
        consequence: "No project rule is created.",
      },
    ],
    recommended: "adopt",
    evidence: found.map((item) => ({ type: "file", location: item.source.path, sha256: item.source.sha256 })),
    required: true,
    requiredAnswer: { type: "single-choice" },
    effect: "config-additive",
    handler: "rules.adopt",
    candidates: found.map((item) => `${item.id}:${item.source.path}`),
  }];
};
