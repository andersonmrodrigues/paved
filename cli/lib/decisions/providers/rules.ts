import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectCheckstyleModules, discoverSources, type CheckstyleModule } from "../../generator-runtime.ts";
import type { Source } from "../../generator-runtime.ts";
import type { DecisionOption } from "../record.ts";
import type { DecisionProvider } from "../gate.ts";

// A generic Checkstyle convention is only the primary configuration file; companion files
// such as checkstyle-suppressions.xml are not a convention on their own.
const CONVENTIONS = [
  { id: "checkstyle", match: /(^|\/)checkstyle\.xml$/ },
  { id: "eslint", match: /(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/ },
] as const;

export interface RuleConvention { readonly id: "checkstyle" | "eslint"; readonly source: Source }

export interface RuleCandidates {
  /** Maven modules whose build enforces their own Checkstyle configuration. */
  readonly modules: readonly CheckstyleModule[];
  /** Configuration observed without a build binding; adopted as agent-enforced rules. */
  readonly conventions: readonly RuleConvention[];
}

export function moduleOptionId(item: CheckstyleModule): string {
  return `module-${item.module}`;
}

export function detectRuleCandidates(projectRoot: string, includeExisting = false): RuleCandidates {
  const sources = discoverSources(projectRoot);
  const bound = detectCheckstyleModules(projectRoot, sources);
  const modules = bound.filter((item) => includeExisting || !existsSync(join(projectRoot, item.rulePath)));
  const conventions = CONVENTIONS.flatMap((convention) => {
    // A build-bound module already carries the precise Checkstyle rule for its code.
    if (convention.id === "checkstyle" && bound.length > 0) return [];
    const rulePath = join(projectRoot, `.paved/rules/quality/${convention.id}.yaml`);
    if (!includeExisting && existsSync(rulePath)) return [];
    const source = sources.find((item) => convention.match.test(item.path));
    return source === undefined ? [] : [{ id: convention.id, source }];
  });
  return { modules, conventions };
}

export const rulesProvider: DecisionProvider = (context) => {
  const { modules, conventions } = detectRuleCandidates(context.projectRoot);
  if (modules.length === 0 && conventions.length === 0) return [];
  const labels = [
    ...modules.map((item) => `Checkstyle in ${item.dir === "." ? "the repository root" : item.dir}`),
    ...conventions.map((item) => `${item.id} (${item.source.path})`),
  ];
  const evidence = [
    ...modules.flatMap((item) => [item.pom, item.config]),
    ...conventions.map((item) => item.source),
  ].map((source) => ({ type: "file" as const, location: source.path, sha256: source.sha256 }));
  const options: DecisionOption[] = [
    {
      id: "adopt", label: "Adopt all as project rules",
      description: labels.join("; "),
      consequence: "Reviews and workflows can cite every adopted rule.",
    },
    // Offering each module separately only helps when there is more than one choice.
    ...(labels.length > 1 ? modules.map((item) => ({
      id: moduleOptionId(item),
      label: `${item.dir === "." ? "Repository root" : item.dir} Checkstyle only`,
      description: `Adopt only the Checkstyle rule enforced by ${item.pom.path}.`,
      consequence: `Only ${item.dir === "." ? "the repository root" : item.dir} gets a project rule.`,
    })) : []),
    {
      id: "decline", label: "Leave observed",
      description: "Keep these configurations as repository evidence only.",
      consequence: "No project rule is created.",
    },
  ];
  return [{
    scope: "project",
    question: `Should the observed ${labels.length === 1 ? "code convention" : "code conventions"} become Paved project rules?`,
    reason: `Paved observed ${labels.join("; ")} in this repository. A project answer is required before these conventions become rules.`,
    options,
    recommended: "adopt",
    evidence,
    required: true,
    requiredAnswer: { type: "single-choice" },
    effect: "config-additive",
    handler: "rules.adopt",
    candidates: [
      ...modules.map((item) => item.candidate),
      ...conventions.map((item) => `${item.id}:${item.source.path}`),
    ],
  }];
};
