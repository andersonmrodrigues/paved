import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ROOT } from "../helpers.ts";

export interface Invocation {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: {
    command?: string; status?: string; data?: any; diagnostics?: { code: string; severity: string }[];
    decisions?: { id: string; question: string; required: boolean; answerChannel: string; recommended?: string; options: { id: string }[] }[];
  };
}

export function hostAvailable(executable: "codex" | "claude"): boolean {
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", shell: false });
  return probe.error === undefined && probe.status === 0;
}

export function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `paved-${prefix}-`));
}

/** What a clone of the GitHub repository contains: tracked and unignored files only. */
export function repositorySnapshot(parent: string): string {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", shell: false });
  if (listed.status !== 0) throw new Error(listed.stderr);
  const target = join(parent, "marketplace");
  for (const path of listed.stdout.split("\0").filter(Boolean)) {
    if (!existsSync(join(ROOT, path))) continue;
    mkdirSync(join(target, path, ".."), { recursive: true });
    cpSync(join(ROOT, path), join(target, path));
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: target, encoding: "utf8", shell: false });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Paved Test", "-c", "user.email=paved@example.invalid", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "commit", "-qm", "snapshot");
  return target;
}

function run(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): SpawnSyncReturns<string> {
  return spawnSync(executable, args, { cwd, encoding: "utf8", shell: false, env: { ...process.env, ...env }, timeout: 120000 });
}

/** Installs through the real Codex plugin CLI into an isolated CODEX_HOME. */
export function installWithCodex(marketplace: string, home: string): string {
  mkdirSync(home, { recursive: true });
  const env = { CODEX_HOME: home };
  const added = run("codex", ["plugin", "marketplace", "add", marketplace], env, home);
  if (added.status !== 0) throw new Error(`codex marketplace add failed: ${added.stderr}${added.stdout}`);
  const installed = run("codex", ["plugin", "add", "paved@paved", "--json"], env, home);
  if (installed.status !== 0) throw new Error(`codex plugin add failed: ${installed.stderr}${installed.stdout}`);
  return (JSON.parse(installed.stdout) as { installedPath: string }).installedPath;
}

/** The skill ids Codex puts in the model-visible prompt for a project. */
export function codexVisibleSkills(home: string, project: string): string[] {
  const prompt = spawnSync("codex", ["debug", "prompt-input", "list skills"], {
    cwd: project, encoding: "utf8", shell: false, env: { ...process.env, CODEX_HOME: home }, input: "", timeout: 60000, maxBuffer: 32 * 1024 * 1024,
  });
  if (prompt.status !== 0) throw new Error(`codex debug prompt-input failed: ${prompt.stderr}`);
  return [...new Set(prompt.stdout.match(/paved:[a-z0-9-]+/g) ?? [])].sort();
}

/** Installs through the real Claude Code plugin CLI into an isolated CLAUDE_CONFIG_DIR. */
export function installWithClaude(marketplace: string, configDir: string): string {
  mkdirSync(configDir, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const added = run("claude", ["plugin", "marketplace", "add", marketplace], env, configDir);
  if (added.status !== 0) throw new Error(`claude marketplace add failed: ${added.stderr}${added.stdout}`);
  const installed = run("claude", ["plugin", "install", "paved@paved"], env, configDir);
  if (installed.status !== 0) throw new Error(`claude plugin install failed: ${installed.stderr}${installed.stdout}`);
  const listed = run("claude", ["plugin", "list", "--json"], env, configDir);
  const entry = (JSON.parse(listed.stdout) as { id: string; installPath: string }[]).find((plugin) => plugin.id === "paved@paved");
  if (entry === undefined) throw new Error(`paved@paved is not listed after install: ${listed.stdout}`);
  return entry.installPath;
}

export function claudeDetails(configDir: string): string {
  const details = run("claude", ["plugin", "details", "paved"], { CLAUDE_CONFIG_DIR: configDir }, configDir);
  if (details.status !== 0) throw new Error(`claude plugin details failed: ${details.stderr}`);
  return details.stdout;
}

/**
 * Runs the installed plugin launcher with no registry and an empty npm cache, so any
 * success proves the runtime came from the plugin's own verified artifact.
 */
export function launcher(pluginRoot: string, npmCache: string) {
  return (cwd: string, ...args: string[]): Invocation => {
    const result = spawnSync(process.execPath, [join(pluginRoot, "bin", "paved.mjs"), ...args], {
      cwd, encoding: "utf8", shell: false, timeout: 180000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_offline: "true", npm_config_cache: npmCache, npm_config_registry: "http://127.0.0.1:9/" },
    });
    let json: Invocation["json"] = {};
    try { json = JSON.parse(result.stdout) as Invocation["json"]; } catch { json = {}; }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
  };
}

/** npm cache entries that did not come from a local file: anything fetched from a registry. */
export function remoteCacheEntries(npmCache: string): string[] {
  const index = join(npmCache, "_cacache", "index-v5");
  if (!existsSync(index)) return [];
  const keys: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else keys.push(...[...readFileSync(path, "utf8").matchAll(/"key":"([^"]+)"/g)].map((match) => match[1]!));
    }
  };
  walk(index);
  return keys.filter((key) => !key.startsWith("pacote:tarball:file:"));
}

export function codeOf(invocation: Invocation): string | undefined {
  return invocation.json.diagnostics?.[0]?.code;
}

export function consumer(parent: string, name: string, files: Record<string, string> = {}): string {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Paved Test", "-c", "user.email=paved@example.invalid", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "commit", "-qm", "baseline");
  return root;
}

/** Digest of every file outside .paved/ and .git/: application state that Paved must not touch. */
export function applicationDigest(root: string, ignore: readonly string[] = []): string {
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = relative(root, full).split(sep).join("/");
      if (path === ".paved" || path === ".git" || path === "AGENTS.md" || ignore.includes(path)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else entries.push(`${path}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** Repacks a runtime tarball as another version, as a later Paved release would be. */
export function repackRuntime(tarball: string, version: string, parent: string): { path: string; integrity: string } {
  const work = join(parent, `repack-${version}`);
  mkdirSync(work, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", work], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr);
  const pkg = join(work, "package");
  const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
  const previous = metadata.version;
  metadata.version = version;
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(pkg, "VERSION"), `${version}\n`);
  writeFileSync(join(pkg, "manifest.yaml"), readFileSync(join(pkg, "manifest.yaml"), "utf8").replace(`version: ${previous}`, `version: ${version}`));
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", parent, "--json"], { cwd: pkg, encoding: "utf8", shell: false });
  if (packed.status !== 0) throw new Error(packed.stderr);
  const [artifact] = JSON.parse(packed.stdout) as { filename: string; integrity: string }[];
  rmSync(work, { recursive: true, force: true });
  return { path: join(parent, artifact!.filename), integrity: artifact!.integrity };
}

/** A copy of an installed plugin whose launcher pins a different runtime artifact. */
export function pluginVariant(pluginRoot: string, parent: string, name: string, runtime: { path: string; integrity: string; version: string }): string {
  const target = join(parent, name);
  cpSync(pluginRoot, target, { recursive: true });
  const file = `paved-core-${runtime.version}.tgz`;
  cpSync(runtime.path, join(target, "runtime", file));
  writeFileSync(join(target, "bin", "bootstrap.json"), `${JSON.stringify({
    package: "paved-core", version: runtime.version, integrity: runtime.integrity, tarball: `../runtime/${file}`, _paved_generated: true,
  }, null, 2)}\n`);
  return target;
}
