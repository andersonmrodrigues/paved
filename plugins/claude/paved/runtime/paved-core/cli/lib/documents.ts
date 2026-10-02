import { readFileSync } from "node:fs";
import { parse } from "yaml";

export function loadYaml(file: string): unknown {
  return parse(readFileSync(file, "utf8"));
}

export interface MarkdownDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function loadMarkdown(file: string): MarkdownDocument {
  const text = readFileSync(file, "utf8");
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text };
  }
  const parsed: unknown = parse(match[1] ?? "");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file}: frontmatter must be a YAML mapping`);
  }
  return { frontmatter: parsed as Record<string, unknown>, body: text.slice(match[0].length) };
}

export function headings(body: string, level: number): string[] {
  const prefix = "#".repeat(level) + " ";
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
}
