// Builds the distributable Paved plugins from Paved Core sources: plugins/paved/ for Codex
// and Cursor, with the runtime's dependencies bundled, and plugins/claude/paved/ for Claude
// Code, whose host installs those dependencies from the plugin's lockfile. Everything in
// both directories is generated: identity comes from plugin-source.json, skills and command
// skills from the canonical Core catalog, the launcher from integrations/shared/bootstrap.mjs
// and the runtime from `npm pack` of this repository, unpacked so every shipped file stays
// readable to plugin directory reviews. Their provenance lives in plugins/provenance/.
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
export const CLAUDE_PLUGIN_DIRECTORY = join("plugins", "claude", "paved");
export const GENERATOR_ID = "paved.plugin.build";
export const RUNTIME_DIRECTORY = "runtime/paved-core";
export const LAUNCHER_DIRECTORY = "scripts";
const GENERATOR_VERSION = "3.0.0";

/** A generated plugin directory and the provenance file that records it, both relative to the repository. */
export interface PluginTarget {
  readonly directory: string;
  readonly provenance: string;
}

export const PLUGIN_TARGETS = {
  portable: { directory: PLUGIN_DIRECTORY, provenance: join("plugins", "provenance", "paved.json") },
  claude: { directory: CLAUDE_PLUGIN_DIRECTORY, provenance: join("plugins", "provenance", "claude-paved.json") },
} as const satisfies Record<string, PluginTarget>;

export interface PluginSource {
  readonly name: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  /** The one-line listing summary; OpenAI's directory allows 30 characters. */
  readonly shortDescription: string;
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
  readonly target: PluginTarget;
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

const PORTABLE_LAUNCHER: LauncherReference = {
  command: `node "<plugin root>/${LAUNCHER_DIRECTORY}/paved.mjs"`,
  location: "`<plugin root>` is the installed Paved plugin directory, two directories above this SKILL.md. Always run the launcher from the repository being worked on, never from the plugin directory.",
};

const CLAUDE_LAUNCHER: LauncherReference = {
  command: `node "\${CLAUDE_PLUGIN_ROOT}/${LAUNCHER_DIRECTORY}/paved.mjs"`,
  location: "Always run it from the repository being worked on, never from the plugin directory.",
};

const ICON = "assets/icon.png";

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function identity(source: PluginSource) {
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    author: source.author,
    homepage: source.homepage,
    repository: source.repository,
    license: source.license,
    keywords: source.keywords,
  };
}

function portableManifests(source: PluginSource): Record<string, unknown> {
  const openaiInterface = {
    displayName: source.displayName,
    shortDescription: source.shortDescription,
    longDescription: source.longDescription,
    developerName: source.author.name,
    category: source.category,
    capabilities: ["Read", "Write"],
    websiteURL: source.homepage,
    defaultPrompt: source.defaultPrompts,
    composerIcon: `./${ICON}`,
    logo: `./${ICON}`,
  };
  return {
    "plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...identity(source),
      extensions: { "com.openai": { interface: openaiInterface } },
    },
    ".codex-plugin/plugin.json": { ...identity(source), skills: "./skills/", interface: openaiInterface },
    ".cursor-plugin/plugin.json": {
      ...identity(source),
      skills: "./skills",
      // Cursor's default discovery would otherwise read the Codex prompt hook file.
      hooks: {},
    },
  };
}

function readme(source: PluginSource, runtime: RuntimeArtifact, hosts: string, dependencies: string, skills: string): string {
  return [
    "<!-- Generated by Paved plugin build; edit plugins/plugin-source.json or Paved Core instead. -->",
    `# ${source.displayName} plugin ${source.version}`,
    "",
    source.longDescription,
    "",
    `This directory is the installable plugin for ${hosts}. It is generated by`,
    "`npm run build:plugin` in the Paved repository and must not be edited by hand.",
    "",
    `- Runtime: \`paved-core@${runtime.version}\` unpacked at \`${RUNTIME_DIRECTORY}/\`; ${dependencies}`,
    `- Runtime integrity: \`${runtime.integrity}\`, checked over the runtime and its dependencies before activation`,
    `- Launcher: \`${LAUNCHER_DIRECTORY}/paved.mjs\``,
    "- Prompt routing: `hooks/hooks.json` adds advisory Paved context once per session in repositories initialized with Paved, and again after compaction.",
    "- Workbench: `paved workbench start` opens the local run dashboard; optional lifecycle hooks show recent agent activity only while it is running.",
    `- Skills: ${skills}`,
    "",
    "Installation and usage: https://github.com/andersonmrodrigues/paved/blob/main/docs/getting-started/installing-the-plugin.md",
    "",
  ].join("\n");
}

const DEPENDENCY_PACKAGE = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+)\/package\.json$/;

/**
 * The npm lockfile that reproduces the runtime's bundled node_modules exactly: the
 * repository lock entries for those packages, registry-pinned and integrity-checked.
 */
function dependencyManifests(root: string, runtime: RuntimeArtifact): { manifest: unknown; lockfile: unknown } {
  const core = JSON.parse(runtime.files.get("package.json")!.toString("utf8")) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, Record<string, unknown>> };
  const name = "paved-plugin-dependencies";
  const dependencies = core.dependencies ?? {};
  const packages: Record<string, unknown> = { "": { name, license: "MIT", dependencies } };
  const installed = [...runtime.files.keys()].map((path) => DEPENDENCY_PACKAGE.exec(path)?.[1]).filter((path): path is string => path !== undefined).sort();
  for (const path of installed) {
    const entry = lock.packages[path];
    if (entry === undefined || entry.dev === true || typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://") || typeof entry.integrity !== "string") {
      throw new Error(`The runtime bundles ${path}, which package-lock.json does not pin as a registry dependency.`);
    }
    // The repository lock marks them bundled into paved-core; here they are top-level installs.
    const { inBundle: _bundled, ...installable } = entry;
    packages[path] = installable;
  }
  for (const dependency of Object.keys(dependencies)) {
    if (!installed.includes(`node_modules/${dependency}`)) throw new Error(`The runtime does not bundle its dependency ${dependency}.`);
  }
  return {
    manifest: { name, private: true, description: "Dependencies of the Paved runtime, installed by the plugin host.", license: "MIT", dependencies },
    lockfile: { name, lockfileVersion: 3, requires: true, packages },
  };
}

function provenanceOf(source: PluginSource, runtime: RuntimeArtifact, files: ReadonlyMap<string, Buffer>, runtimeFiles: number): PluginProvenance {
  return {
    _paved_generated: true,
    generator: { id: GENERATOR_ID, version: GENERATOR_VERSION },
    plugin: { name: source.name, version: source.version },
    runtime: {
      package: "paved-core",
      version: runtime.version,
      directory: RUNTIME_DIRECTORY,
      integrity: runtime.integrity,
      files: runtimeFiles,
    },
    files: Object.fromEntries([...files.keys()].sort().map((path) => [path, sha256(files.get(path)!)])),
  };
}

/** Skills, launcher, hooks and identity files that both plugins share. */
function commonFiles(root: string, source: PluginSource, launcher: LauncherReference): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const header = (origin: string) => `<!-- Generated by Paved plugin ${source.name}@${source.version} from ${origin}; edit Paved Core instead. -->\n`;
  const skills = loadCanonicalSkills(root);
  const commandNames = new Set(AGENT_COMMANDS.map((command) => command.name));
  for (const skill of skills) {
    for (const resource of skillResources(skill)) files.set(`skills/${skill.name}/${resource}`, readFileSync(join(skill.directory, resource)));
  }
  for (const skill of skills) {
    if (commandNames.has(skill.name)) continue;
    files.set(`skills/${skill.name}/SKILL.md`, Buffer.from(renderSkill(skill, header(`${skill.id}@${skill.version}`), launcher)));
  }
  for (const command of AGENT_COMMANDS) {
    // A command that shares its name with a canonical skill carries that skill's
    // guidance, so each name is registered exactly once in either host.
    const skill = skills.find((candidate) => candidate.name === command.name);
    const rendered = renderCommand(command, {
      headerLine: header(skill === undefined ? command.id : `${command.id} and ${skill.id}@${skill.version}`).trimEnd(),
      title: `Paved \`${command.name}\` command (${command.id})`,
      launcher,
      frontmatter: { name: command.name, description: JSON.stringify(`Paved command ${command.id}. ${command.description}`) },
    });
    const guidance = skill === undefined ? "" : `\n## Skill guidance: ${skill.name}\n\n${skill.body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "").trim()}\n`;
    files.set(`skills/${command.name}/SKILL.md`, Buffer.from(`${rendered}${guidance}`));
  }
  files.set(`${LAUNCHER_DIRECTORY}/paved.mjs`, readFileSync(join(root, "integrations", "shared", "bootstrap.mjs")));
  files.set("hooks/hooks.json", readFileSync(join(root, "integrations", "shared", "hooks.json")));
  files.set("hooks/paved-prompt-submit.mjs", readFileSync(join(root, "integrations", "shared", "prompt-submit-hook.mjs")));
  files.set("hooks/paved-workbench.mjs", readFileSync(join(root, "integrations", "shared", "workbench-hook.mjs")));
  files.set("VERSION", Buffer.from(`${source.version}\n`));
  return files;
}

/** Authored behavior-eval fixtures ship with Claude only, never in the portable runtime. */
function claudeEvalFiles(root: string): Map<string, Buffer> {
  const source = join(root, "plugins", "claude", "evals");
  const files = new Map<string, Buffer>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in Claude eval sources: ${relative(source, path)}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = relative(source, path).split(sep).join("/");
        files.set(`evals/${name}`, readFileSync(path));
      } else throw new Error(`Unexpected entry in Claude eval sources: ${relative(source, path)}`);
    }
  };
  walk(source);
  return files;
}

function bootstrapConfig(runtime: RuntimeArtifact, fields: Record<string, string> = {}): Buffer {
  return json({ package: "paved-core", version: runtime.version, integrity: runtime.integrity, runtime: `../${RUNTIME_DIRECTORY}`, ...fields, _paved_generated: true });
}

/** Codex and Cursor install the plugin as committed, so the runtime ships with its dependencies. */
function planPortable(root: string, source: PluginSource, runtime: RuntimeArtifact): PluginPlan {
  const files = commonFiles(root, source, PORTABLE_LAUNCHER);
  for (const [path, value] of Object.entries(portableManifests(source))) files.set(path, json(value));
  files.set(ICON, readFileSync(join(root, "plugins", "icon.png")));
  files.set(`${LAUNCHER_DIRECTORY}/bootstrap.json`, bootstrapConfig(runtime));
  for (const [path, bytes] of runtime.files) files.set(`${RUNTIME_DIRECTORY}/${path}`, bytes);
  files.set("README.md", Buffer.from(readme(source, runtime, "Codex and Cursor", "its dependencies are bundled in its `node_modules/`.", "`paved:<command>` in Codex and `/status` (or another skill name) in Cursor")));
  const target = PLUGIN_TARGETS.portable;
  return { target, files, provenance: provenanceOf(source, runtime, files, runtime.files.size) };
}

/**
 * Claude Code installs the npm dependencies a plugin pins in its root lockfile, so the
 * runtime ships without node_modules and the launcher adds the installed packages back.
 */
function planClaude(root: string, source: PluginSource, runtime: RuntimeArtifact): PluginPlan {
  const files = commonFiles(root, source, CLAUDE_LAUNCHER);
  for (const [path, bytes] of claudeEvalFiles(root)) files.set(path, bytes);
  files.set(".claude-plugin/plugin.json", json({ ...identity(source), displayName: source.displayName }));
  // Claude's plugin directory reads the listing icon from this default path.
  files.set(".claude-plugin/icon.png", readFileSync(join(root, "plugins", "icon.png")));
  files.set(`${LAUNCHER_DIRECTORY}/bootstrap.json`, bootstrapConfig(runtime, { dependencies: ".." }));
  const { manifest, lockfile } = dependencyManifests(root, runtime);
  files.set("package.json", json(manifest));
  files.set("package-lock.json", json(lockfile));
  let runtimeFiles = 0;
  for (const [path, bytes] of runtime.files) {
    if (path.startsWith("node_modules/")) continue;
    files.set(`${RUNTIME_DIRECTORY}/${path}`, bytes);
    runtimeFiles += 1;
  }
  files.set("README.md", Buffer.from(readme(source, runtime, "Claude Code", "Claude Code installs its dependencies from `package-lock.json`.", "`/paved:<command>`")));
  return { target: PLUGIN_TARGETS.claude, files, provenance: provenanceOf(source, runtime, files, runtimeFiles) };
}

export function planPlugins(root: string, runtime: RuntimeArtifact): PluginPlan[] {
  const source = readPluginSource(root);
  if (source.shortDescription.length > 30) throw new Error("plugin-source.json shortDescription exceeds 30 characters.");
  return [planPortable(root, source, runtime), planClaude(root, source, runtime)];
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
 * Compares a plan with its plugin directory. A file is safe to replace or remove only when
 * the previous provenance recorded it and its bytes are unchanged; anything else was edited
 * or added by hand and is reported as a conflict instead of being overwritten.
 */
export function reconcilePlugin(root: string, plan: PluginPlan): Reconciliation {
  const directory = join(root, plan.target.directory);
  const provenancePath = join(root, plan.target.provenance);
  const previous = existsSync(provenancePath)
    ? (JSON.parse(readFileSync(provenancePath, "utf8")) as PluginProvenance).files
    : {};
  const drift: string[] = [];
  const conflicts: string[] = [];
  for (const path of new Set([...existingFiles(directory), ...plan.files.keys()])) {
    const target = join(directory, path);
    const next = plan.files.get(path);
    const current = existsSync(target) ? readFileSync(target) : undefined;
    if (current !== undefined && next !== undefined && current.equals(next)) continue;
    drift.push(path);
    if (current !== undefined && previous[path] !== sha256(current)) conflicts.push(path);
  }
  const recorded = existsSync(provenancePath) ? readFileSync(provenancePath) : undefined;
  if (recorded === undefined || !recorded.equals(json(plan.provenance))) drift.push(plan.target.provenance.split(sep).join("/"));
  return { drift: drift.sort(), conflicts: conflicts.sort() };
}

function atomicWrite(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: "wx" });
  renameSync(temporary, path);
}

function removeEmptyDirectories(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(directory, entry.name);
    removeEmptyDirectories(full);
    if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
  }
}

/** Writes every plan, or nothing when any plugin directory holds a hand edit. */
export function writePlugins(root: string, plans: readonly PluginPlan[]): Reconciliation[] {
  const reconciliations = plans.map((plan) => reconcilePlugin(root, plan));
  const conflicts = reconciliations.flatMap((result, index) => result.conflicts.map((path) => `${plans[index]!.target.directory.split(sep).join("/")}/${path}`));
  if (conflicts.length > 0) {
    throw new Error(`Generated plugin files were modified by hand; restore or remove them before regenerating: ${conflicts.join(", ")}`);
  }
  plans.forEach((plan, index) => {
    const directory = join(root, plan.target.directory);
    for (const path of reconciliations[index]!.drift) {
      const content = plan.files.get(path);
      if (content !== undefined) atomicWrite(join(directory, path), content);
      else if (existsSync(join(directory, path))) rmSync(join(directory, path));
    }
    removeEmptyDirectories(directory);
    // Provenance is written last so an interrupted build is detected as drift.
    atomicWrite(join(root, plan.target.provenance), json(plan.provenance));
    for (const path of existingFiles(directory)) {
      if (!lstatSync(join(directory, path)).isFile()) throw new Error(`Unexpected entry in generated plugin: ${path}`);
    }
  });
  return reconciliations;
}

function main(argv: readonly string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = argv.includes("--check");
  const runtime = packRuntime(root, { build: !argv.includes("--no-build") });
  const plans = planPlugins(root, runtime);
  if (check) {
    const results = plans.map((plan) => ({ plugin: plan.target.directory, ...reconcilePlugin(root, plan) }));
    process.stdout.write(`${JSON.stringify({ command: "build:plugin", check: true, plugins: results }, null, 2)}\n`);
    return results.every((result) => result.drift.length === 0) ? 0 : 1;
  }
  const results = writePlugins(root, plans);
  process.stdout.write(`${JSON.stringify({
    command: "build:plugin",
    plugins: plans.map((plan, index) => ({ plugin: plan.target.directory, written: results[index]!.drift })),
    runtime: plans[0]!.provenance.runtime,
  }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
