import { dirname, join, relative } from "node:path";
import { loadYaml } from "../../cli/lib/documents.ts";
import type { LabeledDocument } from "../../cli/lib/references.ts";
import { at, filesRecursive, rel, subdirectories } from "../helpers.ts";

export interface IdentifiedDocument {
  file: string;
  expectedId: string;
  document: { id: string } & Record<string, unknown>;
}

/** Loads `<root>/<group>/<name>.yaml` documents and derives the id their path implies. */
function loadQualified(root: string, prefix: string): IdentifiedDocument[] {
  return filesRecursive(root, (f) => f.endsWith(".yaml")).map((file) => {
    const group = relative(root, dirname(file));
    const name = relative(dirname(file), file).replace(/\.yaml$/, "");
    return {
      file,
      expectedId: `${prefix}.${group}.${name}`,
      document: loadYaml(file) as IdentifiedDocument["document"],
    };
  });
}

export const coreRules = (): IdentifiedDocument[] => loadQualified(at("core", "rules"), "core");
export const coreTools = (): IdentifiedDocument[] => loadQualified(at("core", "tools"), "core");
export const coreToolImplementations = (): IdentifiedDocument[] => loadQualified(at("core", "tool-implementations"), "core");
export const coreChecks = (): IdentifiedDocument[] => loadQualified(at("core", "verification", "checks"), "core");

export interface SkillLocation {
  category: string;
  name: string;
  dir: string;
}

export function coreSkills(): SkillLocation[] {
  const root = at("core", "skills");
  return subdirectories(root).flatMap((category) =>
    subdirectories(join(root, category)).map((name) => ({ category, name, dir: join(root, category, name) })),
  );
}

/** Every Core rule, tool, check, skill contract and workflow, labeled by path. */
export function coreDocuments(): LabeledDocument[] {
  const files = [
    ...filesRecursive(at("core", "rules"), (f) => f.endsWith(".yaml")),
    ...filesRecursive(at("core", "tools"), (f) => f.endsWith(".yaml")),
    ...filesRecursive(at("core", "tool-implementations"), (f) => f.endsWith(".yaml")),
    ...filesRecursive(at("core", "verification", "checks"), (f) => f.endsWith(".yaml")),
    ...coreSkills().map((skill) => join(skill.dir, "skill.yaml")),
    ...subdirectories(at("core", "workflows")).map((name) => at("core", "workflows", name, "workflow.yaml")),
  ];
  return files.map((file) => ({ label: rel(file), document: loadYaml(file) as Record<string, unknown> }));
}
