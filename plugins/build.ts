// Builds the distributable Paved plugin under plugins/paved/ from Paved Core sources.
// Everything in that directory is generated: identity comes from plugin-source.json,
// skills and command skills from the canonical Core catalog, the launcher from
// integrations/shared/bootstrap.mjs and the runtime from `npm pack` of this repository,
// unpacked so every shipped file stays readable to plugin directory reviews.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCanonicalSkills, skillResources } from "../integrations/shared/catalog.ts";
import { AGENT_COMMANDS } from "../integrations/shared/commands.ts";
import { renderCommand, renderSkill, type LauncherReference } from "../integrations/shared/projection.ts";

export const PLUGIN_DIRECTORY = join("plugins", "paved");
export const PROVENANCE_FILE = "provenance.json";
export const GENERATOR_ID = "paved.plugin.build";
export const RUNTIME_DIRECTORY = "runtime/paved-core";
const GENERATOR_VERSION = "2.0.0";

export interface PluginSource {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly longDescription: string;
  readonly author: { readonly name: string; readonly url?: string };
  readonly homepage: string;
  readonly repository: string;
  readonly license: string;
  readonly keywords: readonly string[];
  readonly category: string;
  readonly defaultPrompts: readonly string[];
}

export interface RuntimeArtifact {
  readonly version: string;
  /** Package files keyed by their path inside the package. */
  readonly files: ReadonlyMap<string, Buffer>;
  readonly integrity: string;
}

export interface PluginProvenance {
  readonly _paved_generated: true;
  readonly generator: { readonly id: string; readonly version: string };
  readonly plugin: { readonly name: string; readonly version: string };
  readonly runtime: {
    readonly package: "paved-core";
    readonly version: string;
    readonly directory: string;
    readonly integrity: string;
    readonly files: number;
  };
  readonly files: Readonly<Record<string, string>>;
}

export interface PluginPlan {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly provenance: PluginProvenance;
}

export interface Reconciliation {
  readonly drift: readonly string[];
  readonly conflicts: readonly string[];
}

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export function readPluginSource(root: string): PluginSource {
  return JSON.parse(readFileSync(join(root, "plugins", "plugin-source.json"), "utf8")) as PluginSource;
}

/**
 * Integrity of an unpacked package: SHA-512 over its sorted `path\0sha256` lines. The
 * launcher computes the same value over the copy it activates.
 */
export function directoryIntegrity(files: ReadonlyMap<string, Buffer>): string {
  const lines = [...files].map(([path, bytes]) => `${path}\0${sha256(bytes)}`).sort();
  return `sha512-${createHash("sha512").update(lines.join("\n")).digest("base64")}`;
}

function readTree(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(relative(directory, full).split(sep).join("/"), readFileSync(full));
      else throw new Error(`Unexpected entry in packed runtime: ${relative(directory, full)}`);
    }
  };
  walk(directory);
  return files;
}

/** Packs this repository as the paved-core runtime and unpacks it. `build` compiles the CLI first. */
export function packRuntime(root: string, options: { build: boolean }): RuntimeArtifact {
  if (options.build) {
    const built = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8", shell: false });
    if (built.status !== 0) throw new Error(`npm run build failed: ${built.stderr || built.stdout}`);
  }
  const workspace = mkdtempSync(join(tmpdir(), "paved-plugin-pack-"));
  try {
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", workspace, "--json"], { cwd: root, encoding: "utf8", shell: false });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const [artifact] = JSON.parse(packed.stdout) as { filename: string; version: string }[];
    if (artifact === undefined) throw new Error("npm pack produced no artifact.");
    const unpacked = spawnSync("tar", ["-xzf", artifact.filename], { cwd: workspace, encoding: "utf8", shell: false });
    if (unpacked.status !== 0) throw new Error(`tar failed to unpack the runtime: ${unpacked.stderr}`);
    const files = readTree(join(workspace, "package"));
    return { version: artifact.version, files, integrity: directoryIntegrity(files) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const PLUGIN_LAUNCHER: LauncherReference = {
  command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/paved.mjs"',
  location: "If that launcher path still contains an unsubstituted plugin-root variable (for example in Codex), use `bin/paved.mjs` at the root of the installed Paved plugin, two directories above this SKILL.md, and quote the path. Always run it from the repository being worked on, never from the plugin directory.",
};

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function manifests(source: PluginSource): Record<string, unknown> {
  const identity = {
    name: source.name,
    version: source.version,
    description: source.description,
    author: source.author,
    homepage: source.homepage,
    repository: source.repository,
    license: source.license,
    keywords: source.keywords,
  };
  const openaiInterface = {
    displayName: source.displayName,
    shortDescription: source.description,
    longDescription: source.longDescription,
    developerName: source.author.name,
    category: source.category,
    capabilities: ["Read", "Write"],
    websiteURL: source.homepage,
    defaultPrompt: source.defaultPrompts,
  };
  return {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...identity,
      extensions: { "com.openai": { interface: openaiInterface } },
    },
    ".codex-plugin/plugin.json": { ...identity, skills: "./skills/", interface: openaiInterface },
    ".claude-plugin/plugin.json": { ...identity, displayName: source.displayName },
    ".cursor-plugin/plugin.json": {
      ...identity,
      skills: "./skills",
      // Cursor's default discovery would otherwise read the shared Claude/Codex hook file.
      hooks: {},
    },
  };
}

function readme(source: PluginSource, runtime: RuntimeArtifact): string {
  return [
    "<!-- Generated by Paved plugin build; edit plugins/plugin-source.json or Paved Core instead. -->",
    `# ${source.displayName} plugin ${source.version}`,
    "",
    source.longDescription,
    "",
    "This directory is the installable plugin for Cursor, Codex and Claude Code. It is generated by",
    "`npm run build:plugin` in the Paved repository and must not be edited by hand.",
    "",
    `- Runtime: \`paved-core@${runtime.version}\` bundled unpacked at \`${RUNTIME_DIRECTORY}/\``,
    `- Runtime integrity: \`${runtime.integrity}\``,
    "- Launcher: `bin/paved.mjs`",
    "- Prompt routing: `hooks/hooks.json` adds advisory Paved context for initialized repositories in Codex and Claude Code; Cursor loads the skills without this hook.",
    "- Skills: `/paved:<command>` in Claude Code, `paved:<command>` in Codex, and `/status` (or another skill name) in Cursor",
    "",
    "Installation and usage: https://github.com/andersonmrodrigues/paved/blob/main/docs/getting-started/installing-the-plugin.md",
    "",
  ].join("\n");
}

export function planPlugin(root: string, runtime: RuntimeArtifact): PluginPlan {
  const source = readPluginSource(root);
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(manifests(source))) files.set(path, json(value));
  // Claude's plugin directory reads the listing icon from this default path.
  files.set(".claude-plugin/icon.png", readFileSync(join(root, "plugins", "icon.png")));

  const header = (origin: string) => `<!-- Generated by Paved plugin ${source.name}@${source.version} from ${origin}; edit Paved Core instead. -->\n`;
  const skills = loadCanonicalSkills(root);
  const commandNames = new Set(AGENT_COMMANDS.map((command) => command.name));
  for (const skill of skills) {
    for (const resource of skillResources(skill)) files.set(`skills/${skill.name}/${resource}`, readFileSync(join(skill.directory, resource)));
  }
  for (const skill of skills) {
    if (commandNames.has(skill.name)) continue;
    files.set(`skills/${skill.name}/SKILL.md`, Buffer.from(renderSkill(skill, header(`${skill.id}@${skill.version}`), PLUGIN_LAUNCHER)));
  }
  for (const command of AGENT_COMMANDS) {
    // A command that shares its name with a canonical skill carries that skill's
    // guidance, so each name is registered exactly once in either host.
    const skill = skills.find((candidate) => candidate.name === command.name);
    const rendered = renderCommand(command, {
      headerLine: header(skill === undefined ? command.id : `${command.id} and ${skill.id}@${skill.version}`).trimEnd(),
      title: `Paved \`${command.name}\` command (${command.id})`,
      launcher: PLUGIN_LAUNCHER,
      frontmatter: { name: command.name, description: JSON.stringify(`Paved command ${command.id}. ${command.description}`) },
    });
    const guidance = skill === undefined ? "" : `\n## Skill guidance: ${skill.name}\n\n${skill.body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim()}\n`;
    files.set(`skills/${command.name}/SKILL.md`, Buffer.from(`${rendered}${guidance}`));
  }

  files.set("bin/paved.mjs", readFileSync(join(root, "integrations", "shared", "bootstrap.mjs")));
  files.set("hooks/hooks.json", readFileSync(join(root, "integrations", "shared", "hooks.json")));
  files.set("hooks/paved-prompt-submit.mjs", readFileSync(join(root, "integrations", "shared", "prompt-submit-hook.mjs")));
  files.set("bin/bootstrap.json", json({
    package: "paved-core",
    version: runtime.version,
    integrity: runtime.integrity,
    runtime: `../${RUNTIME_DIRECTORY}`,
    _paved_generated: true,
  }));
  for (const [path, bytes] of runtime.files) files.set(`${RUNTIME_DIRECTORY}/${path}`, bytes);
  files.set("README.md", Buffer.from(readme(source, runtime)));
  files.set("VERSION", Buffer.from(`${source.version}\n`));

  const provenance: PluginProvenance = {
    _paved_generated: true,
    generator: { id: GENERATOR_ID, version: GENERATOR_VERSION },
    plugin: { name: source.name, version: source.version },
    runtime: {
      package: "paved-core",
      version: runtime.version,
      directory: RUNTIME_DIRECTORY,
      integrity: runtime.integrity,
      files: runtime.files.size,
    },
    files: Object.fromEntries([...files.keys()].sort().map((path) => [path, sha256(files.get(path)!)])),
  };
  return { files, provenance };
}

function existingFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in generated plugin: ${relative(directory, full)}`);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(directory, full).split(sep).join("/"));
    }
  };
  walk(directory);
  return out.sort();
}

/**
 * Compares the plan with plugins/paved/. A file is safe to replace or remove only when
 * the previous provenance recorded it and its bytes are unchanged; anything else was
 * edited or added by hand and is reported as a conflict instead of being overwritten.
 */
export function reconcilePlugin(root: string, plan: PluginPlan): Reconciliation {
  const directory = join(root, PLUGIN_DIRECTORY);
  const provenancePath = join(directory, PROVENANCE_FILE);
  const previous = existsSync(provenancePath)
    ? (JSON.parse(readFileSync(provenancePath, "utf8")) as PluginProvenance).files
    : {};
  const planned = new Map([...plan.files, [PROVENANCE_FILE, json(plan.provenance)]]);
  const drift: string[] = [];
  const conflicts: string[] = [];
  const present = existingFiles(directory);
  for (const path of new Set([...present, ...planned.keys()])) {
    const target = join(directory, path);
    const next = planned.get(path);
    const current = existsSync(target) ? readFileSync(target) : undefined;
    if (current !== undefined && next !== undefined && current.equals(next)) continue;
    drift.push(path);
    if (current === undefined || path === PROVENANCE_FILE) continue;
    if (previous[path] !== sha256(current)) conflicts.push(path);
  }
  return { drift: drift.sort(), conflicts: conflicts.sort() };
}

function atomicWrite(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: "wx" });
  renameSync(temporary, path);
}

export function writePlugin(root: string, plan: PluginPlan): Reconciliation {
  const reconciliation = reconcilePlugin(root, plan);
  if (reconciliation.conflicts.length > 0) {
    throw new Error(`Generated plugin files were modified by hand; restore or remove them before regenerating: ${reconciliation.conflicts.join(", ")}`);
  }
  const directory = join(root, PLUGIN_DIRECTORY);
  for (const path of reconciliation.drift) {
    if (path === PROVENANCE_FILE) continue;
    const target = join(directory, path);
    const content = plan.files.get(path);
    if (content === undefined) rmSync(target, { force: true });
    else atomicWrite(target, content);
  }
  // Provenance is written last so an interrupted build is detected as drift.
  atomicWrite(join(directory, PROVENANCE_FILE), json(plan.provenance));
  for (const path of existingFiles(directory)) {
    if (!lstatSync(join(directory, path)).isFile()) throw new Error(`Unexpected entry in generated plugin: ${path}`);
  }
  return reconciliation;
}

function main(argv: readonly string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = argv.includes("--check");
  const runtime = packRuntime(root, { build: !argv.includes("--no-build") });
  const plan = planPlugin(root, runtime);
  if (check) {
    const result = reconcilePlugin(root, plan);
    process.stdout.write(`${JSON.stringify({ command: "build:plugin", check: true, ...result }, null, 2)}\n`);
    return result.drift.length === 0 ? 0 : 1;
  }
  const result = writePlugin(root, plan);
  process.stdout.write(`${JSON.stringify({ command: "build:plugin", written: result.drift, runtime: plan.provenance.runtime }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
