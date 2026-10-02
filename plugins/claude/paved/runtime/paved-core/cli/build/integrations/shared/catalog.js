import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
function frontmatter(text) {
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
    const name = match?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    return name === undefined ? {} : { name };
}
export function loadCanonicalSkills(coreRoot) {
    const skillsRoot = join(coreRoot, "core", "skills");
    return readdirSync(skillsRoot)
        .flatMap((category) => {
        const categoryRoot = join(skillsRoot, category);
        if (!statSync(categoryRoot).isDirectory())
            return [];
        return readdirSync(categoryRoot)
            .map((name) => join(categoryRoot, name, "SKILL.md"))
            .filter((path) => {
            try {
                return statSync(path).isFile();
            }
            catch {
                return false;
            }
        });
    })
        .sort()
        .map((path) => {
        const body = readFileSync(path, "utf8");
        const name = frontmatter(body).name ?? path.split("/").at(-2);
        const contract = readFileSync(join(path, "..", "skill.yaml"), "utf8");
        const id = /^id:\s*(.+)$/m.exec(contract)?.[1]?.trim() ?? `paved.skill.${name}`;
        const version = /^version:\s*(.+)$/m.exec(contract)?.[1]?.trim() ?? "0.0.0";
        return { name, id, version, body, directory: dirname(path) };
    });
}
/** Files a skill's body may link to (references, examples), relative to its directory. */
export function skillResources(skill) {
    const found = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            if (statSync(path).isDirectory())
                walk(path);
            else if (dir !== skill.directory)
                found.push(relative(skill.directory, path).split(sep).join("/"));
        }
    };
    walk(skill.directory);
    return found;
}
