import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_COMMANDS } from "../../integrations/shared/commands.ts";
import { loadCanonicalSkills } from "../../integrations/shared/catalog.ts";
import {
  CLAUDE_PLUGIN_DIRECTORY, LAUNCHER_DIRECTORY, PLUGIN_DIRECTORY, PLUGIN_TARGETS, RUNTIME_DIRECTORY, packRuntime, planPlugins,
  readPluginSource, reconcilePlugin, writePlugins, type PluginProvenance, type PluginTarget,
} from "../../plugins/build.ts";
import { OPENAI_EXCLUDED, packageOpenAI } from "../../plugins/package-openai.ts";
import { ROOT, filesRecursive, rel, treeIntegrity } from "../helpers.ts";
import { claudeWithDependencies, codexVisibleSkills, hostAvailable, installWithCodex, lockedPackages, repositorySnapshot, workspace } from "./support.ts";

const portable = join(ROOT, PLUGIN_DIRECTORY);
const claude = join(ROOT, CLAUDE_PLUGIN_DIRECTORY);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const provenanceOf = (target: PluginTarget) => readJson<PluginProvenance>(join(ROOT, target.provenance));
const targets = [[portable, PLUGIN_TARGETS.portable], [claude, PLUGIN_TARGETS.claude]] as const;
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
/** Every file under a directory, relative and slash-separated, bundled node_modules included. */
const allFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
  .sort();
const temporary: string[] = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const expectedSkills = (): string[] => {
  const names = new Set([...loadCanonicalSkills(ROOT).map((skill) => skill.name), ...AGENT_COMMANDS.map((command) => command.name)]);
  return [...names].sort();
};

const assertSquarePng = (icon: Buffer) => {
  assert.deepEqual(icon, readFileSync(join(ROOT, "plugins", "icon.png")));
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = icon.readUInt32BE(16);
  assert.equal(width, icon.readUInt32BE(20));
  assert.ok(width >= 512 && width <= 2048, `icon is ${width}px`);
  assert.ok(icon.length < 2 * 1024 * 1024);
};

describe("generated plugins", () => {
  it("projects Claude eval fixtures only into the Claude plugin", () => {
    const plans = planPlugins(ROOT, packRuntime(ROOT, { build: false }));
    const claudePlan = plans.find((plan) => plan.target === PLUGIN_TARGETS.claude)!;
    const portablePlan = plans.find((plan) => plan.target === PLUGIN_TARGETS.portable)!;

    assert.ok(claudePlan.files.has("evals/README.md"));
    assert.ok(claudePlan.files.has("evals/cases/skill-routing/prompt.md"));
    assert.ok(!portablePlan.files.has("evals/README.md"));
    assert.ok(!portablePlan.files.has("evals/cases/skill-routing/prompt.md"));
  });

  it("are exactly what the build produces from the current Core", () => {
    const runtime = packRuntime(ROOT, { build: false });
    for (const plan of planPlugins(ROOT, runtime)) {
      assert.deepEqual(reconcilePlugin(ROOT, plan), { drift: [], conflicts: [] }, `run \`npm run build:plugin\` and commit ${plan.target.directory}/`);
    }
  });

  it("record a digest for every file and nothing else, outside the plugins", () => {
    for (const [plugin, target] of targets) {
      const provenance = provenanceOf(target);
      assert.deepEqual(allFiles(plugin), Object.keys(provenance.files).sort(), target.directory);
      for (const [path, digest] of Object.entries(provenance.files)) assert.equal(sha256(readFileSync(join(plugin, path))), digest, path);
      assert.equal(provenance._paved_generated, true);
      assert.equal(provenance.generator.id, "paved.plugin.build");
    }
  });

  it("keep plugin identity and runtime versions in their own sources", () => {
    const source = readPluginSource(ROOT);
    const core = readJson<{ version: string }>(join(ROOT, "package.json"));
    const manifests: [string, string][] = [
      [portable, "plugin.json"], [portable, ".codex-plugin/plugin.json"], [portable, ".cursor-plugin/plugin.json"], [claude, ".claude-plugin/plugin.json"],
    ];
    for (const [plugin, manifest] of manifests) {
      const value = readJson<{ name: string; version: string; description: string }>(join(plugin, manifest));
      assert.equal(value.name, source.name, manifest);
      assert.equal(value.version, source.version, manifest);
      assert.equal(value.description, source.description, manifest);
    }
    assert.ok(!existsSync(join(portable, ".claude-plugin")), "Claude Code installs plugins/claude/paved/");
    for (const [plugin, target] of targets) {
      const provenance = provenanceOf(target);
      assert.equal(readFileSync(join(plugin, "VERSION"), "utf8").trim(), source.version);
      assert.equal(provenance.plugin.version, source.version);
      assert.equal(provenance.runtime.version, core.version, "the runtime is this repository's paved-core");
      const bootstrap = readJson<{ version: string; integrity: string; runtime: string; tarball?: string; dependencies?: string }>(join(plugin, LAUNCHER_DIRECTORY, "bootstrap.json"));
      assert.equal(bootstrap.version, provenance.runtime.version);
      assert.equal(bootstrap.integrity, provenance.runtime.integrity);
      assert.equal(join(LAUNCHER_DIRECTORY, bootstrap.runtime), join(LAUNCHER_DIRECTORY, "..", provenance.runtime.directory));
      assert.equal(bootstrap.tarball, undefined, "the plugin ships no archive");
      assert.equal(bootstrap.dependencies, plugin === claude ? ".." : undefined);
    }
    assert.equal(provenanceOf(PLUGIN_TARGETS.claude).runtime.integrity, provenanceOf(PLUGIN_TARGETS.portable).runtime.integrity, "both plugins pin the same runtime");
  });

  it("ship the square PNG listing icon where Claude and OpenAI read it", () => {
    assertSquarePng(readFileSync(join(claude, ".claude-plugin", "icon.png")));
    const codex = readJson<{ interface: Record<string, string> }>(join(portable, ".codex-plugin", "plugin.json")).interface;
    const shared = readJson<{ extensions: { "com.openai": { interface: Record<string, string> } } }>(join(portable, "plugin.json")).extensions["com.openai"].interface;
    assert.deepEqual(shared, codex);
    for (const field of ["logo", "composerIcon"]) {
      assert.match(codex[field]!, /^\.\/assets\/[a-z-]+\.png$/, field);
      assertSquarePng(readFileSync(join(portable, codex[field]!)));
    }
  });

  it("keep the OpenAI listing fields within the directory limits", () => {
    const codex = readJson<{ interface: Record<string, unknown> }>(join(portable, ".codex-plugin", "plugin.json")).interface;
    const limits: Record<string, number> = { displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80 };
    for (const [field, limit] of Object.entries(limits)) {
      const value = codex[field];
      assert.ok(typeof value === "string" && value.length > 0 && value.length <= limit, `${field} must be 1-${limit} characters`);
    }
    assert.match(String(codex.websiteURL), /^https:\/\//);
  });

  it("bundle one prompt hook, restored after compaction, discoverable by Codex and Claude Code", () => {
    const codex = readJson<Record<string, unknown>>(join(portable, ".codex-plugin", "plugin.json"));
    const claudeManifest = readJson<Record<string, unknown>>(join(claude, ".claude-plugin", "plugin.json"));
    assert.equal(codex.hooks, undefined, "Codex discovers the default hooks/hooks.json path");
    assert.equal(claudeManifest.hooks, undefined, "Claude Code discovers the default hooks/hooks.json path");
    for (const [plugin, target] of targets) {
      const hooks = readJson<{ hooks: { UserPromptSubmit: { hooks: { type: string; command: string; timeout: number }[] }[] } }>(join(plugin, "hooks", "hooks.json"));
      const [entry] = hooks.hooks.UserPromptSubmit;
      const [command] = entry!.hooks;
      assert.equal(command!.type, "command");
      assert.equal(command!.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/paved-prompt-submit.mjs"');
      assert.equal(command!.timeout, 5);
      const restored = (hooks.hooks as unknown as { SessionStart: { matcher: string; hooks: { command: string }[] }[] }).SessionStart;
      assert.deepEqual(restored.map((item) => [item.matcher, item.hooks[0]!.command]), [["compact|clear", command!.command]], "guidance is restored after compaction or clear");
      assert.deepEqual(readFileSync(join(plugin, "hooks", "paved-prompt-submit.mjs")), readFileSync(join(ROOT, "integrations", "shared", "prompt-submit-hook.mjs")));
      for (const path of ["hooks/hooks.json", "hooks/paved-prompt-submit.mjs"]) assert.ok(provenanceOf(target).files[path] !== undefined, `${path} must be covered by generated provenance`);
    }
  });

  it("declares Cursor skills and disables the shared non-Cursor prompt hook", () => {
    const cursor = readJson<{ name: string; skills: string; hooks: Record<string, unknown> }>(join(portable, ".cursor-plugin", "plugin.json"));
    assert.equal(cursor.name, "paved");
    assert.equal(cursor.skills, "./skills");
    assert.deepEqual(cursor.hooks, {});
  });

  it("bundles an unpacked runtime with its dependencies for Codex and Cursor", () => {
    const provenance = provenanceOf(PLUGIN_TARGETS.portable);
    const runtime = join(portable, provenance.runtime.directory);
    assert.equal(provenance.runtime.directory, RUNTIME_DIRECTORY);
    assert.equal(treeIntegrity(runtime), provenance.runtime.integrity);
    const listing = allFiles(runtime);
    assert.equal(listing.length, provenance.runtime.files);
    assert.ok(listing.includes("cli/build/cli/index.js"));
    assert.ok(listing.includes("node_modules/yaml/package.json"), "dependencies are bundled for offline activation");
    assert.ok(listing.includes("node_modules/ajv/package.json"));
    for (const forbidden of ["tests/", "plugins/", ".paved/", "docs/"]) {
      assert.ok(!listing.some((entry) => entry.startsWith(forbidden)), `${forbidden} must not ship in the runtime`);
    }
    for (const plugin of [portable, claude]) {
      assert.deepEqual(allFiles(plugin).filter((path) => /\.(tgz|tar|gz|zip)$/.test(path)), [], "every shipped file stays readable to directory reviews");
    }
  });

  it("ships the Claude runtime without node_modules and pins its dependencies in a lockfile", () => {
    const provenance = provenanceOf(PLUGIN_TARGETS.claude);
    const listing = allFiles(join(claude, RUNTIME_DIRECTORY));
    assert.equal(listing.length, provenance.runtime.files);
    assert.ok(!listing.some((path) => path.startsWith("node_modules/")));
    assert.deepEqual(listing, allFiles(join(portable, RUNTIME_DIRECTORY)).filter((path) => !path.startsWith("node_modules/")));

    const runtimePackage = readJson<{ dependencies: Record<string, string> }>(join(claude, RUNTIME_DIRECTORY, "package.json"));
    const manifest = readJson<{ private: boolean; dependencies: Record<string, string> }>(join(claude, "package.json"));
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.dependencies, runtimePackage.dependencies);
    for (const version of Object.values(manifest.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, "dependencies are pinned exactly");
    const lock = readJson<{ lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> }> }>(join(claude, "package-lock.json"));
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(lock.packages[""]?.dependencies, manifest.dependencies);
    const bundled = allFiles(join(portable, RUNTIME_DIRECTORY)).map((path) => /^(node_modules\/(?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(path)?.[1]).filter(Boolean).sort();
    assert.deepEqual(lockedPackages(claude), bundled, "the lockfile installs exactly the bundled dependencies");
    for (const path of lockedPackages(claude)) {
      const entry = lock.packages[path]!;
      assert.equal(entry.version, readJson<{ version: string }>(join(portable, RUNTIME_DIRECTORY, path, "package.json")).version, path);
      assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, path);
      assert.match(entry.integrity ?? "", /^sha512-/, path);
    }
  });

  it("reproduces the pinned runtime integrity from the Claude runtime and its locked dependencies", () => {
    const root = workspace("claude-assembly");
    temporary.push(root);
    const assembled = join(root, "paved-core");
    cpSync(join(claude, RUNTIME_DIRECTORY), assembled, { recursive: true });
    for (const path of lockedPackages(claude)) cpSync(join(portable, RUNTIME_DIRECTORY, path), join(assembled, path), { recursive: true });
    assert.equal(treeIntegrity(assembled), provenanceOf(PLUGIN_TARGETS.claude).runtime.integrity);
    const installed = claudeWithDependencies(claude, join(portable, RUNTIME_DIRECTORY), join(root, "installed"));
    assert.ok(existsSync(join(installed, "node_modules", "yaml", "package.json")));
  });

  it("keeps the Claude plugin within Claude's directory limits", () => {
    const files = allFiles(claude);
    assert.ok(files.length <= 512, `${files.length} files`);
    for (const path of files.filter((file) => !/\.(png|jpe?g|gif|webp|woff2?|ttf|otf)$/.test(file))) {
      assert.ok(statSync(join(claude, path)).size < 256 * 1024, `${path} is 256 KiB or larger`);
    }
    for (const forbidden of ["bin", "plugin.json", ".codex-plugin", ".cursor-plugin", "node_modules"]) assert.ok(!existsSync(join(claude, forbidden)), forbidden);
  });

  it("launch through the shared launcher and never embed machine paths", () => {
    for (const plugin of [portable, claude]) {
      assert.deepEqual(readFileSync(join(plugin, LAUNCHER_DIRECTORY, "paved.mjs")), readFileSync(join(ROOT, "integrations", "shared", "bootstrap.mjs")));
      for (const file of filesRecursive(plugin, (path) => /\.(json|md|mjs)$/.test(path))) {
        const text = readFileSync(file, "utf8");
        assert.ok(!text.includes(ROOT), `${rel(file)} embeds the build checkout path`);
        assert.ok(!/\/Users\/|\/home\/|[A-Z]:\\\\/.test(text), `${rel(file)} embeds an absolute machine path`);
      }
      assert.ok(!existsSync(join(plugin, "commands")), "commands are exposed as skills so each name registers once");
      assert.ok(!existsSync(join(plugin, ".mcp.json")), "Paved ships no MCP server");
    }
  });

  it("expose every canonical skill and command exactly once", () => {
    const launchers: [string, string][] = [[portable, 'node "<plugin root>/scripts/paved.mjs"'], [claude, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/paved.mjs"']];
    for (const [plugin, launcher] of launchers) {
      const skills = filesRecursive(join(plugin, "skills"), (path) => path.endsWith("SKILL.md"));
      const names = skills.map((file) => /^---\s*\nname:\s*(\S+)/.exec(readFileSync(file, "utf8"))?.[1]).sort();
      assert.deepEqual(names, expectedSkills());
      for (const command of AGENT_COMMANDS) {
        const body = readFileSync(join(plugin, "skills", command.name, "SKILL.md"), "utf8");
        assert.match(body, /^---\nname: [a-z-]+\ndescription: "Paved command paved\.[a-z-]+\. /);
        assert.ok(body.includes(launcher), command.id);
        assert.ok(body.includes(command.cliCommand), command.id);
      }
      for (const file of skills) {
        if (plugin === portable) assert.ok(!readFileSync(file, "utf8").includes("CLAUDE_PLUGIN_ROOT"), `${rel(file)} must not name a host variable`);
        for (const match of readFileSync(file, "utf8").matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
          assert.ok(existsSync(join(file, "..", match[1]!)), `${rel(file)} links to missing ${match[1]}`);
        }
      }
    }
  });

  it("refuses to overwrite a hand-edited generated file and replaces untouched ones", () => {
    const root = workspace("plugin-edit");
    temporary.push(root);
    for (const path of ["plugins/plugin-source.json", "plugins/icon.png", "plugins/provenance", "plugins/claude/evals", "package-lock.json", "core/skills", "integrations/shared", PLUGIN_DIRECTORY, CLAUDE_PLUGIN_DIRECTORY]) {
      cpSync(join(ROOT, path), join(root, path), { recursive: true });
    }
    const runtime = packRuntime(ROOT, { build: false });
    for (const plan of planPlugins(root, runtime)) assert.deepEqual(reconcilePlugin(root, plan).drift, []);
    const edited = join(root, CLAUDE_PLUGIN_DIRECTORY, "skills", "status", "SKILL.md");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}\nLocal note.\n`);
    writeFileSync(join(root, CLAUDE_PLUGIN_DIRECTORY, "notes.md"), "Added by hand.\n");
    const [, claudePlan] = planPlugins(root, runtime);
    assert.deepEqual(reconcilePlugin(root, claudePlan!).conflicts, ["notes.md", "skills/status/SKILL.md"]);
    const source = readJson<Record<string, unknown>>(join(root, "plugins", "plugin-source.json"));
    writeFileSync(join(root, "plugins", "plugin-source.json"), JSON.stringify({ ...source, version: "1.0.1" }));
    assert.throws(() => writePlugins(root, planPlugins(root, runtime)), /modified by hand/);
    assert.ok(readFileSync(edited, "utf8").includes("Local note."), "a refused build writes nothing");
    assert.equal(readFileSync(join(root, PLUGIN_DIRECTORY, "VERSION"), "utf8"), readFileSync(join(portable, "VERSION"), "utf8"), "neither plugin is written");

    rmSync(join(root, CLAUDE_PLUGIN_DIRECTORY, "notes.md"));
    writeFileSync(edited, readFileSync(join(claude, "skills", "status", "SKILL.md")));
    const written = writePlugins(root, planPlugins(root, runtime));
    for (const result of written) assert.ok(result.drift.includes("VERSION"));
    for (const directory of [PLUGIN_DIRECTORY, CLAUDE_PLUGIN_DIRECTORY]) assert.equal(readFileSync(join(root, directory, "VERSION"), "utf8"), "1.0.1\n");
    for (const plan of planPlugins(root, runtime)) assert.deepEqual(reconcilePlugin(root, plan).drift, []);
  });

  it("packs the Codex plugin for OpenAI's directory without hooks", () => {
    const root = workspace("openai-zip");
    temporary.push(root);
    for (const path of ["plugins/plugin-source.json", PLUGIN_DIRECTORY]) cpSync(join(ROOT, path), join(root, path), { recursive: true });
    const zip = packageOpenAI(root);
    assert.ok(statSync(zip).size < 100 * 1024 * 1024);
    const listed = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(listed.status, 0, listed.stderr);
    const entries = listed.stdout.split("\n").filter(Boolean);
    assert.ok(entries.length <= 5000, `${entries.length} entries`);
    const files = entries.filter((entry) => !entry.endsWith("/")).sort();
    const expected = allFiles(portable).filter((path) => !OPENAI_EXCLUDED.some((pattern) => path.startsWith(pattern.replace("*", ""))));
    assert.deepEqual(files, expected);
    assert.ok(files.includes(".codex-plugin/plugin.json") && files.includes("plugin.json") && files.includes("assets/icon.png"));
    assert.ok(!files.some((path) => path.startsWith("hooks/")), "OpenAI rejects plugins with lifecycle hooks");
  });
});

describe("repository marketplaces", () => {
  it("list the generated plugin for Codex by relative local path", () => {
    const marketplace = readJson<{ name: string; plugins: { name: string; source: { source: string; path: string }; policy: Record<string, string>; category: string }[] }>(
      join(ROOT, ".agents", "plugins", "marketplace.json"),
    );
    assert.equal(marketplace.name, "paved");
    assert.equal(marketplace.plugins.length, 1);
    const [entry] = marketplace.plugins;
    assert.deepEqual(entry?.source, { source: "local", path: "./plugins/paved" });
    assert.deepEqual(entry?.policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
    assert.ok(statSync(join(ROOT, entry!.source.path, ".codex-plugin", "plugin.json")).isFile());
  });

  it("list the generated plugin for Claude Code by relative path", () => {
    const marketplace = readJson<{ name: string; owner: { name: string }; plugins: { name: string; source: string }[] }>(join(ROOT, ".claude-plugin", "marketplace.json"));
    assert.equal(marketplace.name, "paved");
    assert.ok(marketplace.owner.name.length > 0);
    assert.deepEqual(marketplace.plugins.map((entry) => [entry.name, entry.source]), [["paved", "./plugins/claude/paved"]]);
    assert.ok(statSync(join(ROOT, marketplace.plugins[0]!.source, ".claude-plugin", "plugin.json")).isFile());
  });

  it("list the generated plugin for Cursor by relative path", () => {
    const marketplace = readJson<{
      name: string;
      owner: { name: string };
      metadata: { description: string };
      plugins: { name: string; source: string; description: string; version: string }[];
    }>(join(ROOT, ".cursor-plugin", "marketplace.json"));
    assert.equal(marketplace.name, "paved");
    assert.ok(marketplace.owner.name.length > 0);
    assert.ok(marketplace.metadata.description.length > 0);
    assert.deepEqual(marketplace.plugins.map((entry) => [entry.name, entry.source]), [["paved", "./plugins/paved"]]);
    assert.equal(marketplace.plugins[0]?.version, readPluginSource(ROOT).version);
    assert.ok(statSync(join(ROOT, marketplace.plugins[0]!.source, ".cursor-plugin", "plugin.json")).isFile());
  });

  it("pass Claude Code strict plugin validation", { skip: hostAvailable("claude") ? false : "claude CLI is not installed" }, () => {
    for (const target of [ROOT, claude]) {
      const validated = spawnSync("claude", ["plugin", "validate", target, "--strict"], { encoding: "utf8", shell: false, timeout: 120000 });
      assert.equal(validated.status, 0, validated.stdout + validated.stderr);
    }
  });

  it("install through Codex and expose every skill to the model", { skip: hostAvailable("codex") ? false : "codex CLI is not installed" }, () => {
    const root = workspace("codex-discovery");
    temporary.push(root);
    const installed = installWithCodex(repositorySnapshot(root), join(root, "codex-home"));
    assert.ok(installed.includes(join("plugins", "cache", "paved", "paved")), installed);
    const project = join(root, "project");
    mkdirSync(project);
    const visible = codexVisibleSkills(join(root, "codex-home"), project);
    assert.deepEqual(visible, expectedSkills().map((name) => `paved:${name}`));
  });
});
