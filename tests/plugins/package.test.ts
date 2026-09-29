import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_COMMANDS } from "../../integrations/shared/commands.ts";
import { loadCanonicalSkills } from "../../integrations/shared/catalog.ts";
import {
  PLUGIN_DIRECTORY, PROVENANCE_FILE, archiveContentDigest, packRuntime, planPlugin, readPluginSource,
  reconcilePlugin, selectRuntime, writePlugin, type PluginProvenance,
} from "../../plugins/build.ts";
import { ROOT, filesRecursive, rel } from "../helpers.ts";
import { codexVisibleSkills, hostAvailable, installWithCodex, repositorySnapshot, workspace } from "./support.ts";

const plugin = join(ROOT, PLUGIN_DIRECTORY);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const provenance = readJson<PluginProvenance>(join(plugin, PROVENANCE_FILE));
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const temporary: string[] = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const expectedSkills = (): string[] => {
  const names = new Set([...loadCanonicalSkills(ROOT).map((skill) => skill.name), ...AGENT_COMMANDS.map((command) => command.name)]);
  return [...names].sort();
};

describe("generated plugin", () => {
  it("is exactly what the build produces from the current Core", () => {
    const runtime = selectRuntime(ROOT, packRuntime(ROOT, { build: false }));
    const result = reconcilePlugin(ROOT, planPlugin(ROOT, runtime));
    assert.deepEqual(result, { drift: [], conflicts: [] }, "run `npm run build:plugin` and commit plugins/paved/");
  });

  it("records a digest for every file and nothing else", () => {
    const present = filesRecursive(plugin, () => true).map((file) => rel(file).slice(PLUGIN_DIRECTORY.length + 1)).filter((path) => path !== PROVENANCE_FILE).sort();
    assert.deepEqual(present, Object.keys(provenance.files).sort());
    for (const [path, digest] of Object.entries(provenance.files)) assert.equal(sha256(readFileSync(join(plugin, path))), digest, path);
    assert.equal(provenance._paved_generated, true);
    assert.equal(provenance.generator.id, "paved.plugin.build");
  });

  it("keeps plugin identity and runtime versions in their own sources", () => {
    const source = readPluginSource(ROOT);
    const core = readJson<{ version: string }>(join(ROOT, "package.json"));
    for (const manifest of ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
      const value = readJson<{ name: string; version: string; description: string }>(join(plugin, manifest));
      assert.equal(value.name, source.name, manifest);
      assert.equal(value.version, source.version, manifest);
      assert.equal(value.description, source.description, manifest);
    }
    assert.equal(readFileSync(join(plugin, "VERSION"), "utf8").trim(), source.version);
    assert.equal(provenance.plugin.version, source.version);
    assert.equal(provenance.runtime.version, core.version, "the bundled runtime is this repository's paved-core");
    const bootstrap = readJson<{ version: string; integrity: string; tarball: string }>(join(plugin, "bin", "bootstrap.json"));
    assert.equal(bootstrap.version, provenance.runtime.version);
    assert.equal(bootstrap.integrity, provenance.runtime.integrity);
    assert.equal(join("bin", bootstrap.tarball), join("bin", "..", provenance.runtime.file));
  });

  it("bundles one prompt hook discoverable by both plugin hosts", () => {
    const codex = readJson<Record<string, unknown>>(join(plugin, ".codex-plugin", "plugin.json"));
    const claude = readJson<Record<string, unknown>>(join(plugin, ".claude-plugin", "plugin.json"));
    assert.equal(codex.hooks, undefined, "Codex discovers the default hooks/hooks.json path");
    assert.equal(claude.hooks, undefined, "Claude Code discovers the default hooks/hooks.json path");

    const hooks = readJson<{ hooks: { UserPromptSubmit: { hooks: { type: string; command: string; timeout: number }[] }[] } }>(join(plugin, "hooks", "hooks.json"));
    const [entry] = hooks.hooks.UserPromptSubmit;
    const [command] = entry!.hooks;
    assert.equal(command!.type, "command");
    assert.equal(command!.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/paved-prompt-submit.mjs"');
    assert.equal(command!.timeout, 5);
    assert.deepEqual(
      readFileSync(join(plugin, "hooks", "paved-prompt-submit.mjs")),
      readFileSync(join(ROOT, "integrations", "shared", "prompt-submit-hook.mjs")),
    );
    for (const path of ["hooks/hooks.json", "hooks/paved-prompt-submit.mjs"]) {
      assert.ok(provenance.files[path] !== undefined, `${path} must be covered by generated provenance`);
    }
  });

  it("bundles a runtime whose bytes and contents match the provenance", () => {
    const bytes = readFileSync(join(plugin, provenance.runtime.file));
    assert.equal(bytes.length, provenance.runtime.bytes);
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, provenance.runtime.integrity);
    assert.equal(archiveContentDigest(bytes), provenance.runtime.content_sha256);
    const listing = spawnSync("tar", ["-tzf", join(plugin, provenance.runtime.file)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    assert.ok(listing.includes("package/cli/build/cli/index.js"));
    assert.ok(listing.includes("package/node_modules/yaml/package.json"), "dependencies are bundled for offline activation");
    assert.ok(listing.includes("package/node_modules/ajv/package.json"));
    for (const forbidden of ["package/tests/", "package/plugins/", "package/.paved/", "package/docs/"]) {
      assert.ok(!listing.some((entry) => entry.startsWith(forbidden)), `${forbidden} must not ship in the runtime`);
    }
  });

  it("launches through the shared launcher and never embeds machine paths", () => {
    assert.deepEqual(readFileSync(join(plugin, "bin", "paved.mjs")), readFileSync(join(ROOT, "integrations", "shared", "bootstrap.mjs")));
    for (const file of filesRecursive(plugin, (path) => /\.(json|md|mjs)$/.test(path))) {
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes(ROOT), `${rel(file)} embeds the build checkout path`);
      assert.ok(!/\/Users\/|\/home\/|[A-Z]:\\\\/.test(text), `${rel(file)} embeds an absolute machine path`);
    }
    assert.ok(!existsSync(join(plugin, "commands")), "commands are exposed as skills so each name registers once");
    assert.ok(!existsSync(join(plugin, ".mcp.json")), "Paved ships no MCP server");
  });

  it("exposes every canonical skill and command exactly once", () => {
    const skills = filesRecursive(join(plugin, "skills"), (path) => path.endsWith("SKILL.md"));
    const names = skills.map((file) => /^---\s*\nname:\s*(\S+)/.exec(readFileSync(file, "utf8"))?.[1]).sort();
    assert.deepEqual(names, expectedSkills());
    for (const command of AGENT_COMMANDS) {
      const body = readFileSync(join(plugin, "skills", command.name, "SKILL.md"), "utf8");
      assert.match(body, /^---\nname: [a-z-]+\ndescription: "Paved command paved\.[a-z-]+\. /);
      assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/paved.mjs"'), command.id);
      assert.ok(body.includes(command.cliCommand), command.id);
    }
    for (const file of skills) {
      for (const match of readFileSync(file, "utf8").matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
        assert.ok(existsSync(join(file, "..", match[1]!)), `${rel(file)} links to missing ${match[1]}`);
      }
    }
  });

  it("refuses to overwrite a hand-edited generated file and replaces untouched ones", () => {
    const root = workspace("plugin-edit");
    temporary.push(root);
    for (const path of ["plugins/plugin-source.json", "core/skills", "integrations/shared", PLUGIN_DIRECTORY]) {
      cpSync(join(ROOT, path), join(root, path), { recursive: true });
    }
    const runtime = selectRuntime(ROOT, packRuntime(ROOT, { build: false }));
    assert.deepEqual(reconcilePlugin(root, planPlugin(root, runtime)).drift, []);
    const edited = join(root, PLUGIN_DIRECTORY, "skills", "status", "SKILL.md");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}\nLocal note.\n`);
    writeFileSync(join(root, PLUGIN_DIRECTORY, "notes.md"), "Added by hand.\n");
    const result = reconcilePlugin(root, planPlugin(root, runtime));
    assert.deepEqual(result.conflicts, ["notes.md", "skills/status/SKILL.md"]);
    assert.throws(() => writePlugin(root, planPlugin(root, runtime)), /modified by hand/);
    assert.ok(readFileSync(edited, "utf8").includes("Local note."), "a refused build writes nothing");

    rmSync(join(root, PLUGIN_DIRECTORY, "notes.md"));
    writeFileSync(edited, readFileSync(join(plugin, "skills", "status", "SKILL.md")));
    const source = readJson<Record<string, unknown>>(join(root, "plugins", "plugin-source.json"));
    writeFileSync(join(root, "plugins", "plugin-source.json"), JSON.stringify({ ...source, version: "1.0.1" }));
    const written = writePlugin(root, planPlugin(root, runtime));
    assert.ok(written.drift.includes("VERSION"));
    assert.equal(readFileSync(join(root, PLUGIN_DIRECTORY, "VERSION"), "utf8"), "1.0.1\n");
    assert.deepEqual(reconcilePlugin(root, planPlugin(root, runtime)).drift, []);
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
    assert.deepEqual(marketplace.plugins.map((entry) => [entry.name, entry.source]), [["paved", "./plugins/paved"]]);
    assert.ok(statSync(join(ROOT, marketplace.plugins[0]!.source, ".claude-plugin", "plugin.json")).isFile());
  });

  it("pass Claude Code strict plugin validation", { skip: hostAvailable("claude") ? false : "claude CLI is not installed" }, () => {
    for (const target of [ROOT, plugin]) {
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
