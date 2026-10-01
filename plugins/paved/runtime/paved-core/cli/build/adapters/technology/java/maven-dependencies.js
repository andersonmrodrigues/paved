import { readFileSync } from "node:fs";
import { join } from "node:path";
const comments = /<!--[\s\S]*?-->/g;
const block = (xml, tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1];
const value = (xml, tag) => block(xml, tag)?.trim();
const remove = (xml, tag) => xml.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g"), "");
function parsePom(projectRoot, scope) {
    const xml = readFileSync(join(projectRoot, scope, "pom.xml"), "utf8").replace(comments, "");
    const parent = block(xml, "parent") ?? "";
    const direct = ["parent", "dependencies", "dependencyManagement", "build", "profiles", "repositories", "pluginRepositories", "properties", "modules"]
        .reduce(remove, xml);
    const dependenciesXml = ["dependencyManagement", "build", "profiles"].reduce(remove, xml);
    const dependencies = [...dependenciesXml.matchAll(/<dependency(?:\s[^>]*)?>([\s\S]*?)<\/dependency>/g)]
        .map((match) => ({
        groupId: value(match[1], "groupId"),
        artifactId: value(match[1], "artifactId"),
        version: value(match[1], "version"),
    }));
    return {
        scope,
        groupId: value(direct, "groupId") ?? value(parent, "groupId"),
        artifactId: value(direct, "artifactId"),
        version: value(direct, "version") ?? value(parent, "version"),
        dependencies,
    };
}
/** Resolve direct local Maven dependencies without guessing about external artifacts. */
export function planMavenDependencies(projectRoot, scopes) {
    const projects = [...new Set(scopes)].map((scope) => parsePom(projectRoot, scope));
    const byCoordinate = new Map();
    for (const project of projects) {
        if (!project.groupId || !project.artifactId)
            continue;
        const key = `${project.groupId}:${project.artifactId}`;
        if (byCoordinate.has(key))
            throw new Error(`Duplicate local Maven coordinate ${key}.`);
        byCoordinate.set(key, project);
    }
    const dependencies = new Map(projects.map((project) => [project.scope, new Set()]));
    const installs = new Set();
    for (const project of projects) {
        for (const dependency of project.dependencies) {
            if (!dependency.groupId || !dependency.artifactId)
                continue;
            const local = byCoordinate.get(`${dependency.groupId}:${dependency.artifactId}`);
            if (!local)
                continue;
            // An explicit, different version names a different artifact in the local repository.
            if (dependency.version && local.version && !dependency.version.startsWith("${") && dependency.version !== local.version)
                continue;
            dependencies.get(project.scope).add(local.scope);
            installs.add(local.scope);
        }
    }
    const ordered = [];
    const active = new Set();
    const done = new Set();
    const visit = (scope) => {
        if (active.has(scope))
            throw new Error(`Local Maven dependency cycle at ${scope}.`);
        if (done.has(scope))
            return;
        active.add(scope);
        for (const dependency of [...dependencies.get(scope)].sort())
            visit(dependency);
        active.delete(scope);
        done.add(scope);
        ordered.push(scope);
    };
    for (const scope of [...dependencies.keys()].sort())
        visit(scope);
    return { scopes: ordered, installs };
}
