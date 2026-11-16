import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { GardenerInputError } from "./gardener.ts";
import { loadRuleCatalog, type CatalogRule } from "./rule-catalog.ts";
import { resolveConsumerPath, resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";

/** Who writes correction proposals, as recorded in their sidecar provenance. */
export const CORRECTION_GENERATOR = "gardener";
export const PROPOSAL_DIR = ".paved/generated/proposals/rules/corrections";
export const RULE_DIR = ".paved/rules/corrections";
/** Word overlap at or above which a statement restates a rule. */
export const DUPLICATE_SIMILARITY = 0.6;
/** Word overlap at or above which a rule is shown as related, for a person to compare. */
export const RELATED_SIMILARITY = 0.3;
const MAX_TEXT = 2000;

type Source = { id: string; type: "file" | "revision" | "human" | "url"; location: string; sha256?: string; lines?: string; revision?: string; captured_at?: string };
interface Sidecar {
  apiVersion: "paved/v1"; kind: "GeneratedArtifact";
  artifact: { path: string; format: "yaml"; schema: "Rule"; api_version: "paved/v1"; proposal_for: string };
  ownership: "disposable";
  provenance: { generator: string; generator_version: string; generated_at: string; source_revision?: string; sources: Source[]; output_sha256: string; review: { status: "unreviewed" } };
}

export interface RuleMatch { readonly id: string; readonly origin: CatalogRule["origin"]; readonly path: string; readonly similarity: number }
export interface CorrectionResult {
  readonly outcome: "proposed" | "merged" | "duplicate";
  readonly rule_id: string;
  /** The proposal file, absent when the statement duplicates an existing rule. */
  readonly proposal?: string;
  readonly proposal_for?: string;
  /** How many times a person stated this correction, counting this one. */
  readonly occurrences: number;
  readonly duplicate_of?: RuleMatch;
  readonly related: readonly RuleMatch[];
  readonly written: boolean;
}
export interface CorrectionProposal { readonly path: string; readonly proposal_for: string; readonly rule_id: string; readonly rule: string; readonly sha256: string; readonly occurrences: number }

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Lower-case words without diacritics, so the same statement matches however it is typed. */
function words(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
const normalized = (text: string): string => words(text).join(" ");
// Short words are mostly articles and prepositions in any language; a trailing s is a plural.
const terms = (text: string): Set<string> => new Set(words(text).filter((word) => word.length >= 3).map((word) => word.length > 3 ? word.replace(/s$/, "") : word));

/** Deterministic word overlap (Jaccard) between two statements; 1 when they normalize to the same text. */
export function similarity(a: string, b: string): number {
  if (normalized(a) === normalized(b)) return 1;
  const left = terms(a);
  const right = terms(b);
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((term) => right.has(term)).length;
  return Math.round((shared / (left.size + right.size - shared)) * 100) / 100;
}

function slugFor(text: string): string {
  const ascii = words(text).map((word) => word.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  const kept: string[] = [];
  for (const word of ascii) {
    if ([...kept, word].join("-").length > 40) break;
    kept.push(word);
  }
  return `${kept.length > 0 ? kept.join("-") : "correction"}-${sha(normalized(text)).slice(0, 8)}`;
}

function titleFor(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 77);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}...`;
}

function git(root: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  return result.error === undefined && result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * One piece of evidence for a correction: a repository file (`path`, `path:12` or
 * `path:12-40`), a commit, or a URL. Free text is refused: the person's own words are the
 * only text a proposal quotes.
 */
export function evidenceSource(roots: { projectRoot: string; sourceRoot: string }, ref: string, at: string): Omit<Source, "id"> {
  const value = ref.trim();
  if (/^https?:\/\/\S+$/.test(value)) return { type: "url", location: value, captured_at: at };
  const located = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(value);
  const path = located?.[1]?.replaceAll("\\", "/");
  if (path !== undefined && !isAbsolute(path) && !path.split("/").includes("..")) {
    let full: string | undefined;
    try { full = resolveConsumerPath(roots.projectRoot, roots.sourceRoot, path); } catch { full = undefined; }
    if (full !== undefined && existsSync(full) && statSync(full).isFile()) {
      const start = located?.[2];
      const end = located?.[3];
      if (start !== undefined && end !== undefined && Number(end) < Number(start)) throw new GardenerInputError(`Evidence ${ref} has a line range that ends before it starts.`);
      return { type: "file", location: path.replace(/^\.\//, ""), sha256: sha(readFileSync(full)),
        ...(start === undefined ? {} : { lines: end === undefined ? start : `${start}-${end}` }) };
    }
  }
  if (/^[0-9a-f]{7,64}$/i.test(value)) {
    const commit = git(roots.sourceRoot, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`]);
    if (commit !== undefined) return { type: "revision", location: commit, revision: commit };
  }
  throw new GardenerInputError(`Evidence ${ref} is not a file in this repository (path, path:line or path:start-end), a commit or an http(s) URL.`);
}

function readSidecar(projectRoot: string, path: string): Sidecar | undefined {
  const full = resolveSafePath(projectRoot, `${path}.paved.yaml`);
  if (!existsSync(full)) return undefined;
  try {
    const sidecar = parse(readFileSync(full, "utf8")) as Partial<Sidecar> | null;
    return sidecar?.provenance?.generator === CORRECTION_GENERATOR && sidecar.artifact?.schema === "Rule" ? sidecar as Sidecar : undefined;
  } catch { return undefined; }
}

/** Correction proposals awaiting a person's decision, oldest path first. */
export function correctionProposals(projectRoot: string, coreRoot: string): CorrectionProposal[] {
  return loadRuleCatalog({ projectRoot, coreRoot, proposals: true })
    .filter((rule) => rule.origin === "proposal")
    .flatMap((rule) => {
      const sidecar = readSidecar(projectRoot, rule.path);
      if (sidecar === undefined) return [];
      return [{ path: rule.path, proposal_for: sidecar.artifact.proposal_for, rule_id: rule.id, rule: rule.rule,
        sha256: sha(readFileSync(resolveSafePath(projectRoot, rule.path))),
        occurrences: sidecar.provenance.sources.filter((source) => source.type === "human").length }];
    });
}

function ruleDocument(id: string, text: string, occurrences: number, references: readonly string[]) {
  return {
    apiVersion: "paved/v1", kind: "Rule", id, title: titleFor(text),
    rationale: `A person stated this as a correction ${occurrences === 1 ? "once" : `${occurrences} times`}; it is quoted verbatim in rule. Adopted only by a person's decision.`,
    applies_to: {},
    rule: text,
    enforcement: { mechanism: "agent", layer: "rule" },
    severity: "warning",
    verification: "Record in the evidence whether the change complies with this rule; a reviewer checks the diff against the rule text.",
    ...(references.length > 0 ? { references: [...references] } : {}),
  };
}

const HEADER = (target: string) => [
  "# Proposed by `paved gardener correction` from a person's correction, quoted verbatim in `rule`.",
  `# Nothing loads it until a person adopts it with \`paved gardener\`, which writes ${target}.`,
  "# Unknown: the statement gave no file scope or severity; applies_to is everywhere and severity",
  "# is warning. Narrow them in the adopted rule, not here.",
].join("\n");

/**
 * Turns a person's correction into a rule proposal under .paved/generated/proposals/. A
 * statement that restates an existing Core or project rule writes nothing; one that
 * restates a pending correction proposal adds its evidence to that proposal. Rules under
 * .paved/rules/ are never written here.
 */
export function proposeCorrection(input: {
  projectRoot: string; sourceRoot?: string; coreRoot: string; text: string; evidence: readonly string[]; dryRun?: boolean; at?: string;
}): CorrectionResult {
  if (!existsSync(join(input.projectRoot, ".paved/manifest.yaml"))) throw new GardenerInputError("Consumer manifest is missing.");
  const text = input.text.trim();
  if (text === "") throw new GardenerInputError("The correction text is empty; pass the person's words verbatim with --text.");
  if (text.length > MAX_TEXT) throw new GardenerInputError(`The correction text is longer than ${MAX_TEXT} characters; record one rule per correction.`);
  if (words(text).length === 0) throw new GardenerInputError("The correction text has no words.");
  if (input.evidence.length === 0) throw new GardenerInputError("A correction needs at least one --evidence: the file, commit or URL that shows the mistake it corrects.");
  const sourceRoot = input.sourceRoot ?? input.projectRoot;
  const at = input.at ?? new Date().toISOString();
  const evidence = input.evidence.map((ref) => evidenceSource({ projectRoot: input.projectRoot, sourceRoot }, ref, at));

  const catalog = loadRuleCatalog({ projectRoot: input.projectRoot, coreRoot: input.coreRoot, proposals: true });
  const pending = new Map(correctionProposals(input.projectRoot, input.coreRoot).map((proposal) => [proposal.path, proposal]));
  const scored = catalog
    .map((rule) => ({ rule, similarity: Math.max(similarity(text, rule.rule), similarity(text, rule.title)) }))
    .filter((entry) => entry.similarity >= RELATED_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity || a.rule.id.localeCompare(b.rule.id, "en"));
  const match = (entry: (typeof scored)[number]): RuleMatch => ({ id: entry.rule.id, origin: entry.rule.origin, path: entry.rule.path, similarity: entry.similarity });
  const best = scored.find((entry) => entry.similarity >= DUPLICATE_SIMILARITY);
  const related = scored.filter((entry) => entry !== best).map(match);

  if (best !== undefined && !pending.has(best.rule.path)) {
    return { outcome: "duplicate", rule_id: best.rule.id, occurrences: 1, duplicate_of: match(best), related, written: false };
  }

  const existing = best === undefined ? undefined : pending.get(best.rule.path);
  const slug = slugFor(text);
  const path = existing?.path ?? `${PROPOSAL_DIR}/${slug}.yaml`;
  const target = existing?.proposal_for ?? `${RULE_DIR}/${slug}.yaml`;
  const id = existing?.rule_id ?? `project.corrections.${slug}`;
  const ruleText = existing?.rule ?? text;
  const previous = existing === undefined ? undefined : readSidecar(input.projectRoot, existing.path);
  if (previous !== undefined && previous.provenance.output_sha256 !== existing!.sha256) {
    throw new GardenerInputError(`${existing!.path} was edited after it was proposed. Adopt or delete it with paved gardener before restating the correction.`);
  }

  const statement: Omit<Source, "id"> = { type: "human", location: "conversation: a person stated this correction", captured_at: at };
  const prior = (previous?.provenance.sources ?? []).map(({ id: _id, ...source }) => source);
  const key = (source: Omit<Source, "id">) => JSON.stringify([source.type, source.location, source.sha256 ?? "", source.lines ?? ""]);
  const merged = [...prior];
  for (const source of [statement, ...evidence]) {
    if (source.type === "human" || !merged.some((item) => key(item) === key(source))) merged.push(source);
  }
  const sources = merged.map((source, index) => ({ id: `source-${index + 1}`, ...source }));
  const occurrences = sources.filter((source) => source.type === "human").length;
  const references = [...new Set(sources.filter((source) => source.type !== "human").map((source) => source.location))].sort();
  const document = ruleDocument(id, ruleText, occurrences, references);
  const content = `${HEADER(target)}\n${stringify(document)}`;
  const revision = git(sourceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const sidecar: Sidecar = {
    apiVersion: "paved/v1", kind: "GeneratedArtifact",
    artifact: { path, format: "yaml", schema: "Rule", api_version: "paved/v1", proposal_for: target },
    ownership: "disposable",
    provenance: {
      generator: CORRECTION_GENERATOR, generator_version: readFileSync(join(input.coreRoot, "VERSION"), "utf8").trim(),
      generated_at: at, ...(revision === undefined ? {} : { source_revision: revision }),
      sources, output_sha256: sha(content), review: { status: "unreviewed" },
    },
  };
  const registry = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]);
  for (const doc of [document, sidecar]) {
    const result = registry.validate(doc);
    if (!result.valid) throw new GardenerInputError(`The correction proposal is invalid: ${result.errors.join("; ")}`);
  }
  if (!input.dryRun) {
    const full = resolveSafePath(input.projectRoot, path);
    mkdirSync(dirname(full), { recursive: true });
    atomicWriteFileSync(full, content);
    atomicWriteFileSync(resolveSafePath(input.projectRoot, `${path}.paved.yaml`), stringify(sidecar));
  }
  return {
    outcome: existing === undefined ? "proposed" : "merged", rule_id: id, proposal: path, proposal_for: target,
    occurrences, related, written: !input.dryRun,
    ...(existing === undefined || best === undefined ? {} : { duplicate_of: match(best) }),
  };
}

const HANDLER_PREFIX = "gardener.correction:";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The decision handler key for one correction proposal; it names the proposal by its file name only. */
export function correctionHandlerKey(proposal: string): string {
  return `${HANDLER_PREFIX}${proposal.slice(proposal.lastIndexOf("/") + 1).replace(/\.yaml$/, "")}`;
}

/** The proposal and rule paths a handler key stands for, or undefined when it is not a correction key. */
export function correctionPaths(key: string): { proposal: string; target: string } | undefined {
  if (!key.startsWith(HANDLER_PREFIX)) return undefined;
  const slug = key.slice(HANDLER_PREFIX.length);
  return SLUG.test(slug) ? { proposal: `${PROPOSAL_DIR}/${slug}.yaml`, target: `${RULE_DIR}/${slug}.yaml` } : undefined;
}

/**
 * Adopts a pending correction proposal: writes it, without the draft header, to its
 * project rule path and removes the proposal. Idempotent: a proposal already adopted
 * reports the rule it became.
 */
export function adoptCorrection(input: { projectRoot: string; coreRoot: string; proposal: string; target: string }): string {
  const target = resolveSafePath(input.projectRoot, input.target);
  const source = resolveSafePath(input.projectRoot, input.proposal);
  if (!existsSync(source)) {
    if (existsSync(target)) return input.target;
    throw new Error(`The correction proposal ${input.proposal} no longer exists.`);
  }
  const document = parse(readFileSync(source, "utf8")) as unknown;
  const result = createRegistry(join(input.coreRoot, "schemas"), ["paved/v1"]).validate(document);
  if (!result.valid) throw new Error(`${input.proposal} is invalid: ${result.errors.join("; ")}`);
  if (existsSync(target) && JSON.stringify(parse(readFileSync(target, "utf8"))) !== JSON.stringify(document)) {
    throw new Error(`Refusing to overwrite an existing Paved document: ${input.target}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  atomicWriteFileSync(target, stringify(document));
  rmSync(source, { force: true });
  rmSync(resolveSafePath(input.projectRoot, `${input.proposal}.paved.yaml`), { force: true });
  return input.target;
}
