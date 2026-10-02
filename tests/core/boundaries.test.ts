import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { ROOT, at, coreManifest, filesRecursive, rel, type Component } from "../helpers.ts";

const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
const TS_IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s+["']([^"']+)["']/gm;
// A qualified id owned by a project or an adapter: project.<group>.<name>, adapter-<x>.<group>.<name>.
const FOREIGN_ID = /\b(?:project|adapter-[a-z0-9-]+)\.[a-z0-9-]+\.[a-z0-9-]+\b/;

const components = coreManifest().components;
const byName = new Map(components.map((c) => [c.name, c]));

function componentOf(file: string): Component | undefined {
  const top = relative(ROOT, file).split(sep)[0];
  return components.find((c) => c.path === top);
}

/** Every repository-relative reference a file makes: Markdown links and TypeScript imports. */
function references(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const pattern = file.endsWith(".ts") ? TS_IMPORT : MARKDOWN_LINK;
  return [...text.matchAll(pattern)]
    .map((match) => match[1]!.split("#")[0]!)
    .filter((target) => target !== "" && !/^(https?:|mailto:)/.test(target) && (file.endsWith(".md") || target.startsWith(".")))
    .map((target) => resolve(dirname(file), target));
}

describe("component boundaries", () => {
  it("cover every top-level directory", () => {
    const directories = readdirSync(ROOT)
      .filter((name) => !name.startsWith(".") && name !== "node_modules" && statSync(at(name)).isDirectory())
      // Ignored directories, such as dist/ from `npm run package:openai`, are local build output.
      .filter((name) => spawnSync("git", ["check-ignore", "-q", name], { cwd: ROOT }).status !== 0)
      .sort();
    assert.deepEqual(components.map((c) => c.path).sort(), directories);
  });

  it("depend only on declared components, without cycles", () => {
    for (const component of components) {
      for (const dependency of component.depends_on) {
        assert.ok(byName.has(dependency), `${component.name} depends on unknown component ${dependency}`);
      }
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]) => {
      assert.ok(!visiting.has(name), `dependency cycle: ${[...path, name].join(" -> ")}`);
      if (done.has(name)) return;
      visiting.add(name);
      for (const dependency of byName.get(name)!.depends_on) visit(dependency, [...path, name]);
      visiting.delete(name);
      done.add(name);
    };
    for (const component of components) visit(component.name, []);
  });

  it("let distributed components depend only on distributed components", () => {
    for (const component of components.filter((c) => c.distributed)) {
      for (const dependency of component.depends_on) {
        assert.ok(byName.get(dependency)?.distributed, `${component.name} is distributed but depends on ${dependency}`);
      }
    }
  });

  it("reference other components only through declared dependencies", () => {
    const violations: string[] = [];
    for (const file of filesRecursive(ROOT, (f) => f.endsWith(".md") || f.endsWith(".ts"))) {
      const source = componentOf(file);
      if (source === undefined) continue; // root files (README, AGENTS.md) describe the whole repository
      for (const target of references(file)) {
        const destination = componentOf(target);
        if (destination === undefined || destination === source) continue;
        if (!source.depends_on.includes(destination.name)) {
          violations.push(`${rel(file)} (${source.name}) -> ${relative(ROOT, target)} (${destination.name})`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  it("keep Core content free of project and adapter ids", () => {
    const roots = ["skills", "workflows", "rules", "tools"].map((dir) => at("core", dir));
    const offenders = roots
      .flatMap((root) => filesRecursive(root, (f) => f.endsWith(".yaml")))
      .filter((file) => FOREIGN_ID.test(readFileSync(file, "utf8")))
      .map(rel);
    assert.deepEqual(offenders, []);
  });

  it("keep adapter content free of project ids", () => {
    const offenders = filesRecursive(at("adapters"), (f) => f.endsWith(".yaml"))
      .filter((file) => /\bproject\.[a-z0-9-]+\.[a-z0-9-]+\b/.test(readFileSync(file, "utf8")))
      .map(rel);
    assert.deepEqual(offenders, []);
  });
});
