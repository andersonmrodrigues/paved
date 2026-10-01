import { readFileSync } from "node:fs";
import { parse } from "yaml";
export function loadYaml(file) {
    return parse(readFileSync(file, "utf8"));
}
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
export function loadMarkdown(file) {
    const text = readFileSync(file, "utf8");
    const match = FRONTMATTER.exec(text);
    if (!match) {
        return { frontmatter: {}, body: text };
    }
    const parsed = parse(match[1] ?? "");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${file}: frontmatter must be a YAML mapping`);
    }
    return { frontmatter: parsed, body: text.slice(match[0].length) };
}
export function headings(body, level) {
    const prefix = "#".repeat(level) + " ";
    return body
        .split(/\r?\n/)
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length).trim());
}
