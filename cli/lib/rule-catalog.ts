import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { globRegex } from "./adapters.ts";
import { loadYaml } from "./documents.ts";

export type RuleOrigin = "core" | "project" | "proposal";

/** A Rule document as far as matching and scoping need it. */
export interface CatalogRule {
  readonly id: string;
  readonly origin: RuleOrigin;
  /** Core-relative for Core rules, consumer-relative otherwise. */
  readonly path: string;
  readonly title: string;
  readonly rule: string;
  readonly paths?: readonly string[];
}

function walk(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile() && entry.name.endsWith(".yaml") && !entry.name.endsWith(".paved.yaml")) visit(path);
  }
}

function collect(root: string, dir: string, origin: RuleOrigin, into: CatalogRule[]): void {
  walk(join(root, dir), (path) => {
    let doc: { kind?: unknown; id?: unknown; title?: unknown; rule?: unknown; applies_to?: { paths?: unknown } } | null;
    // An unreadable document is reported by status and doctor; here it simply matches nothing.
    try { doc = loadYaml(path) as typeof doc; } catch { return; }
    if (doc?.kind !== "Rule" || typeof doc.id !== "string" || typeof doc.title !== "string" || typeof doc.rule !== "string") return;
    const paths = doc.applies_to?.paths;
    into.push({
      id: doc.id, origin, path: relative(root, path).split(sep).join("/"), title: doc.title, rule: doc.rule,
      ...(Array.isArray(paths) && paths.every((item) => typeof item === "string") ? { paths: paths as string[] } : {}),
    });
  });
}

/** Core rules, the consumer's project rules and, when asked, the rule proposals awaiting adoption. */
export function loadRuleCatalog(input: { projectRoot: string; coreRoot: string; proposals?: boolean }): CatalogRule[] {
  const rules: CatalogRule[] = [];
  collect(input.coreRoot, "core/rules", "core", rules);
  collect(input.projectRoot, ".paved/rules", "project", rules);
  if (input.proposals) collect(input.projectRoot, ".paved/generated/proposals/rules", "proposal", rules);
  return rules;
}

/** Whether a rule constrains any of the files; a rule without path selectors applies everywhere. */
export function ruleCovers(rule: CatalogRule, files: readonly string[]): boolean {
  if (rule.paths === undefined) return true;
  const patterns = rule.paths.map(globRegex);
  return files.some((file) => patterns.some((pattern) => pattern.test(file)));
}
