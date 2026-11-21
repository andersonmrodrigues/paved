import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCanonicalSkills } from "../../integrations/shared/catalog.ts";
import { packRuntime, planPlugins } from "../../plugins/build.ts";
import { ROOT } from "../helpers.ts";
import { at } from "../helpers.ts";

const root = at("core", "skills", "lean");
const names = ["paved", "setup", "feature", "bug", "refactor", "investigate", "verify", "review", "ship", "reflect", "task", "design"];
const read = (name: string) => readFileSync(join(root, `${name}.md`), "utf8");

describe("lean playbooks", () => {
  it("discovers lean skills alongside legacy skills and projects them into both plugins", () => {
    const skills = loadCanonicalSkills(ROOT);
    for (const name of names) {
      assert.ok(skills.some((skill) => skill.name === name), `missing canonical skill ${name}`);
    }
    const plans = planPlugins(ROOT, packRuntime(ROOT, { build: false }));
    assert.equal(plans.length, 2);
    for (const plan of plans) {
      for (const name of [...names, "feature-development", "security-review", "app-verification"]) {
        assert.ok(plan.files.has(`skills/${name}/SKILL.md`), `${plan.target.directory}: ${name}`);
      }
      const router = plan.files.get("skills/paved/SKILL.md")!.toString("utf8");
      for (const name of names.filter((name) => name !== "paved")) {
        assert.ok(router.includes(`\`${name}\``), `router omits ${name}`);
      }
      for (const name of names) {
        const resource = `skills/${name}/references/playbook.md`;
        assert.ok(plan.files.has(resource), `missing distributed reference ${resource}`);
      }
    }
  });

  it("keeps the router and playbooks within conservative byte budgets", () => {
    // UTF-8 bytes are an intentionally stricter ceiling than token estimates.
    // Supporting references are loaded on demand, not part of the default instructions.
    const canonical = new Map(loadCanonicalSkills(ROOT).map((skill) => [skill.name, skill.body]));
    for (const name of names) {
      const text = read(name);
      assert.ok(Buffer.byteLength(text) <= (name === "paved" ? 1500 : 1000), name);
      assert.match(text, /^# .+/m);
      assert.ok(Buffer.byteLength(canonical.get(name)!) <= (name === "paved" ? 1500 : 1000), `canonical ${name}`);
    }
    for (const name of names.filter((name) => name !== "paved")) {
      assert.ok(Buffer.byteLength(read("paved") + read(name) + read("verify")) <= 3000, name);
      assert.ok(
        Buffer.byteLength(canonical.get("paved")! + canonical.get(name)! + canonical.get("verify")!) <= 3000,
        `canonical task ${name}`,
      );
    }
  });

  it("routes each task and points to existing specialized guidance", () => {
    const router = read("paved");
    for (const name of names.filter((name) => name !== "paved")) {
      assert.ok(router.includes(`(${name}.md)`), name);
      const text = read(name);
      for (const [, path] of text.matchAll(/\]\((\.\.\/[^)]+)\)/g)) {
        assert.ok(path);
        assert.ok(existsSync(join(root, path)), `${name}: ${path}`);
      }
    }
  });

  it("covers scoped changes, escalation, and honest proof", () => {
    assert.match(read("paved"), /assumption/i);
    assert.match(read("task"), /mid-flow[\s\S]*same goal/i);
    assert.match(read("setup"), /uninitialized[\s\S]*outdated/i);
    assert.match(read("ship"), /irreversible[\s\S]*approval/i);
    assert.match(read("verify"), /two distinct[\s\S]*fail/i);
    assert.match(read("verify"), /VERIFIED[\s\S]*NOT VERIFIED[\s\S]*INFERRED/);
    const canonical = new Map(loadCanonicalSkills(ROOT).map((skill) => [skill.name, skill.body]));
    assert.match(canonical.get("paved")!, /assumption[\s\S]*ambiguity/);
    assert.match(canonical.get("task")!, /mid-flow[\s\S]*same goal[\s\S]*note/);
    assert.match(canonical.get("ship")!, /Irreversible actions[\s\S]*approval/);
    assert.match(canonical.get("verify")!, /two distinct[\s\S]*fail[\s\S]*escalate/);
    assert.match(canonical.get("verify")!, /VERIFIED[\s\S]*NOT VERIFIED[\s\S]*INFERRED/);
  });

  it("uses direct execution by default instead of requiring a workflow plan", () => {
    const instructions = readFileSync(at("core", "instructions", "AGENTS.md"), "utf8");
    const template = readFileSync(at("core", "templates", "AGENTS.md"), "utf8");
    for (const text of [instructions, template]) {
      assert.match(text, /default to direct/i);
      assert.match(text, /paved verify --changed/);
      assert.match(text, /only when[\s\S]*workflow/i);
      assert.doesNotMatch(text, /start every repository change with .*intent/i);
      assert.doesNotMatch(text, /Implementation requires explicit human approval of the current plan/i);
    }
  });
});
