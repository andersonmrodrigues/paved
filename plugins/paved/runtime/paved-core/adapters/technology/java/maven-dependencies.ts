import { readFileSync } from "node:fs";
import { join } from "node:path";

interface MavenProject {
  scope: string;
  groupId: string | undefined;
  artifactId: string | undefined;
  version: string | undefined;
  dependencies: { groupId: string | undefined; artifactId: string | undefined; version: string | undefined }[];
}

const comments = /<!--[\s\S]*?-->/g;
const block = (xml: string, tag: string): string | undefined =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1];
const value = (xml: string, tag: string): string | undefined => block(xml, tag)?.trim();
const remove = (xml: string, tag: string): string =>
  xml.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"), "");

function parsePom(projectRoot: string, scope: string): MavenProject {
  const xml = readFileSync(join(projectRoot, scope, "pom.xml"), "utf8").replace(comments, "");
  const parent = block(xml, "parent") ?? "";
  const direct = ["parent", "dependencies", "dependencyManagement", "build", "profiles", "repositories", "pluginRepositories", "properties", "modules"]
    .reduce(remove, xml);
  const dependenciesXml = ["dependencyManagement", "build", "profiles"].reduce(remove, xml);
  const dependencies = [...dependenciesXml.matchAll(/<dependency(?:\s[^>]*)?>([\s\S]*?)<\/dependency>/g)]
    .map((match) => ({
      groupId: value(match[1]!, "groupId"),
      artifactId: value(match[1]!, "artifactId"),
      version: value(match[1]!, "version"),
    }));
  return {
    scope,
    groupId: value(direct, "groupId") ?? value(parent, "groupId"),
    artifactId: value(direct, "artifactId"),
    version: value(direct, "version") ?? value(parent, "version"),
    dependencies,
  };
}

export interface MavenDependencyPlan {
  /** Dependency-first order for the supplied Maven project directories. */
  readonly scopes: readonly string[];
  /** Modules whose tests must also install their artifact for local consumers. */
  readonly installs: ReadonlySet<string>;
}

/** Resolve direct local Maven dependencies without guessing about external artifacts. */
export function planMavenDependencies(projectRoot: string, scopes: readonly string[]): MavenDependencyPlan {
  const projects = [...new Set(scopes)].map((scope) => parsePom(projectRoot, scope));
  const byCoordinate = new Map<string, MavenProject>();
  for (const project of projects) {
    if (!project.groupId || !project.artifactId) continue;
    const coordinate = `${project.groupId}:${project.artifactId}`;
    if (byCoordinate.has(coordinate)) throw new Error(`Duplicate local Maven coordinate ${coordinate}.`);
    byCoordinate.set(coordinate, project);
  }
  const dependencies = new Map(projects.map((project) => [project.scope, new Set<string>()]));
  const installs = new Set<string>();
  for (const project of projects) {
    for (const dependency of project.dependencies) {
      if (!dependency.groupId || !dependency.artifactId) continue;
      const local = byCoordinate.get(`${dependency.groupId}:${dependency.artifactId}`);
      if (!local) continue;
      // An explicit, different version names a different artifact in the local repository.
      if (dependency.version && local.version && !dependency.version.startsWith("${") && dependency.version !== local.version) continue;
      dependencies.get(project.scope)!.add(local.scope);
      installs.add(local.scope);
    }
  }
  const ordered: string[] = [];
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (scope: string): void => {
    if (active.has(scope)) throw new Error(`Local Maven dependency cycle at ${scope}.`);
    if (done.has(scope)) return;
    active.add(scope);
    for (const dependency of [...dependencies.get(scope)!].sort()) visit(dependency);
    active.delete(scope);
    done.add(scope);
    ordered.push(scope);
  };
  for (const scope of [...dependencies.keys()].sort()) visit(scope);
  return { scopes: ordered, installs };
}
