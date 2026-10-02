import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { loadMarkdown, loadYaml, type MarkdownDocument } from "./documents.ts";
import type { SchemaRegistry } from "./schemas.ts";

export type MigrationSourceVersion = string | undefined;

export interface DocumentMigration {
  readonly id: string;
  readonly fromApiVersion: MigrationSourceVersion;
  readonly toApiVersion: string;
  readonly documentKinds: readonly string[];
  readonly description: string;
  appliesTo(document: unknown): boolean;
  apply(document: unknown): unknown;
}

export interface PlannedDocumentMigration {
  readonly id: string;
  readonly path: string;
  readonly fromApiVersion?: string;
  readonly toApiVersion: string;
}

export interface MigrationDiagnostic {
  readonly path: string;
  readonly message: string;
}

export const documentMigrations: readonly DocumentMigration[] = [
  {
    id: "legacy-document-to-paved-v1",
    fromApiVersion: undefined,
    toApiVersion: "paved/v1",
    documentKinds: ["Project", "Lock", "Adapter", "CapabilityRegistry", "Rule", "Skill", "Workflow",
      "WorkflowRun", "Check", "Decision", "Tool", "ToolImplementation", "Evidence", "VerificationProfile",
      "Feature", "ContextDocument", "Overrides", "Generator", "GeneratedArtifact", "GardenerObservation",
      "GardenerProposal", "GardenerReviews", "CoreImprovementCandidate", "AgentIntegration"],
    description: "Adds the required paved/v1 API version to a legacy document.",
    appliesTo: (document) => document !== null && typeof document === "object" &&
      !Array.isArray(document) && !("apiVersion" in document),
    apply: (document) => ({ apiVersion: "paved/v1", ...(document as Record<string, unknown>) }),
  },
];

const directories = ["project", "rules", "skills", "workflows", "tools", "tool-implementations",
  "verification/checks"];

function walkFiles(directory: string, visit: (path: string) => void): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(path, visit);
    else visit(path);
  }
}

function apiVersionOf(document: unknown): string | undefined {
  if (document !== null && typeof document === "object" && !Array.isArray(document)) {
    const value = (document as { apiVersion?: unknown }).apiVersion;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function kindOf(document: unknown): string | undefined {
  if (document !== null && typeof document === "object" && !Array.isArray(document)) {
    const value = (document as { kind?: unknown }).kind;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function candidates(document: unknown): DocumentMigration[] {
  const version = apiVersionOf(document);
  const kind = kindOf(document);
  return documentMigrations.filter((migration) =>
    migration.fromApiVersion === version &&
    (kind === undefined || migration.documentKinds.includes(kind)) &&
    migration.appliesTo(document));
}

function readDocument(path: string): { document: unknown; markdown: MarkdownDocument | undefined } {
  if (path.endsWith(".md")) {
    const markdown = loadMarkdown(path);
    return { document: markdown.frontmatter, markdown };
  }
  return { document: loadYaml(path), markdown: undefined };
}

function writeDocument(path: string, document: unknown, markdown: MarkdownDocument | undefined): void {
  if (markdown) {
    writeFileSync(path, `---\n${stringify(document).trimEnd()}\n---\n${markdown.body}`);
    return;
  }
  writeFileSync(path, stringify(document));
}

export function planDocumentMigrations(
  projectRoot: string,
  registry: SchemaRegistry,
): { migrations: PlannedDocumentMigration[]; diagnostics: MigrationDiagnostic[] } {
  const migrations: PlannedDocumentMigration[] = [];
  const diagnostics: MigrationDiagnostic[] = [];
  for (const directory of directories) {
    walkFiles(join(projectRoot, ".paved", directory), (full) => {
      if (!/\.(yaml|yml|md)$/.test(full) || full.endsWith("SKILL.md") || full.endsWith("WORKFLOW.md")) return;
      const path = relative(projectRoot, full).split(sep).join("/");
      try {
        const { document } = readDocument(full);
        if (registry.validate(document).valid) return;
        const matches = candidates(document);
        if (matches.length === 1) {
          const migration = matches[0]!;
          migrations.push({ id: migration.id, path, toApiVersion: migration.toApiVersion,
            ...(migration.fromApiVersion === undefined ? {} : { fromApiVersion: migration.fromApiVersion }) });
          return;
        }
        diagnostics.push({
          path,
          message: matches.length === 0
            ? "document has no known deterministic migration"
            : "multiple deterministic migrations match this document",
        });
      } catch {
        diagnostics.push({ path, message: "document cannot be parsed under the candidate Core" });
      }
    });
  }
  return { migrations, diagnostics };
}

export function applyDocumentMigrations(
  projectRoot: string,
  planned: readonly PlannedDocumentMigration[],
  registry: SchemaRegistry,
): void {
  for (const item of planned) {
    const path = join(projectRoot, item.path);
    const { document, markdown } = readDocument(path);
    const migration = documentMigrations.find((candidate) => candidate.id === item.id);
    if (!migration || !migration.appliesTo(document)) throw new Error(`Migration ${item.id} is no longer applicable to ${item.path}.`);
    const migrated = migration.apply(document);
    const validation = registry.validate(migrated);
    if (!validation.valid) throw new Error(`Migration ${item.id} produced an invalid document at ${item.path}.`);
    writeDocument(path, migrated, markdown);
  }
}
