import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CanonicalSkill {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly body: string;
}

function frontmatter(text: string): { name?: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  const name = match?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  return name === undefined ? {} : { name };
}

export function loadCanonicalSkills(coreRoot: string): CanonicalSkill[] {
  const skillsRoot = join(coreRoot, "core", "skills");
  return readdirSync(skillsRoot)
    .flatMap((category) => {
      const categoryRoot = join(skillsRoot, category);
      if (!statSync(categoryRoot).isDirectory()) return [];
      return readdirSync(categoryRoot)
        .map((name) => join(categoryRoot, name, "SKILL.md"))
        .filter((path) => {
          try { return statSync(path).isFile(); } catch { return false; }
        });
    })
    .sort()
    .map((path) => {
      const body = readFileSync(path, "utf8");
      const name = frontmatter(body).name ?? path.split("/").at(-2)!;
      const contract = readFileSync(join(path, "..", "skill.yaml"), "utf8");
      const id = /^id:\s*(.+)$/m.exec(contract)?.[1]?.trim() ?? `paved.skill.${name}`;
      const version = /^version:\s*(.+)$/m.exec(contract)?.[1]?.trim() ?? "0.0.0";
      return { name, id, version, body };
    });
}
