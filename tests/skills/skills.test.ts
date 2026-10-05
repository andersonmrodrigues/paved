import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { headings, loadMarkdown, loadYaml } from "../../cli/lib/documents.ts";
import { loadEvidenceRegistry } from "../../cli/lib/evidence.ts";
import {
  assessSkillEvidence,
  assessSkillQuality,
  dependencyCycles,
  duplicatedSentences,
  unprovingRequiredChecks,
  type SkillContract,
  type SkillFiles,
} from "../../cli/lib/skills.ts";
import { at, filesRecursive, formatErrors, rel, schemas, subdirectories } from "../helpers.ts";
import { coreRules, coreSkills } from "../core/registries.ts";
import { AGENT_COMMANDS } from "../../integrations/shared/commands.ts";

// Frontmatter fields defined by https://agentskills.io/specification
const AGENT_SKILLS_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SUPPORT_DIRS = ["references", "examples", "scripts", "assets"];

function loadSkill(dir: string): SkillFiles {
  const md = loadMarkdown(join(dir, "SKILL.md"));
  const supporting: Record<string, string> = {};
  for (const sub of SUPPORT_DIRS) {
    for (const file of filesRecursive(join(dir, sub), () => true)) {
      supporting[relative(dir, file)] = readFileSync(file, "utf8");
    }
  }
  return {
    contract: loadYaml(join(dir, "skill.yaml")) as SkillContract,
    description: String(md.frontmatter.description ?? ""),
    body: md.body,
    supporting,
  };
}

const ruleStatements = new Map(coreRules().map((r) => [r.document.id, String(r.document.rule)]));

describe("core skills", () => {
  const locations = coreSkills();
  const skills = locations.map((location) => ({ ...location, files: loadSkill(location.dir) }));
  const sections = headings(loadMarkdown(at("core", "templates", "skill.md")).body, 2);

  it("exist in every category the schema allows", () => {
    const schema = loadYaml(at("schemas", "skill.schema.yaml")) as { properties: { category: { enum: string[] } } };
    const categories = new Set(skills.map((s) => s.category));
    for (const category of schema.properties.category.enum) {
      assert.ok(categories.has(category), `no Core skill in category ${category}`);
    }
  });

  // Agents discover skills by their SKILL.md name, so short names must not collide.
  it("have unique names", () => {
    const names = skills.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("expose 30 goal-and-trigger descriptions to Claude", () => {
    const catalog = [
      ...skills.map((skill) => ({ name: skill.name, description: skill.files.description })),
      ...AGENT_COMMANDS.map((command) => ({ name: command.name, description: command.description })),
    ];
    assert.equal(catalog.length, 30);
    assert.equal(new Set(catalog.map((entry) => entry.name)).size, 30);
    for (const { name, description } of catalog) {
      assert.ok(description.length > 0 && description.length <= 1024, `${name}: description length`);
      assert.match(description, /\buse when\b/i, `${name}: name the activation condition with “Use when …”`);
    }
  });

  it("routes repository orientation to context discovery even without a change request", () => {
    const description = skills.find((skill) => skill.name === "context-discovery")?.files.description;
    assert.ok(description);
    assert.match(description, /repository orientation/i);
    assert.match(description, /onboarding/i);
    assert.match(description, /even when no change is requested/i);
  });

  it("form an acyclic dependency graph", () => {
    assert.deepEqual(dependencyCycles(skills.map((s) => s.files.contract)), []);
  });

  it("do not repeat each other's sentences", () => {
    const texts = skills.map((s) => ({
      id: s.files.contract.id,
      text: [s.files.body, ...Object.values(s.files.supporting)].join("\n\n"),
    }));
    assert.deepEqual(duplicatedSentences(texts), []);
  });

  it("depend only on skills that are not deprecated", () => {
    const status = new Map(skills.map((s) => [s.files.contract.id, s.files.contract.status]));
    for (const { files } of skills) {
      const deps = [...(files.contract.depends_on?.required ?? []), ...(files.contract.depends_on?.optional ?? [])];
      for (const dep of deps) assert.notEqual(status.get(dep), "deprecated", `${files.contract.id} depends on deprecated ${dep}`);
    }
  });

  const supports = new Map(
    Object.entries(loadEvidenceRegistry(at("core", "verification", "registry.yaml")).checkTypes).map(([type, v]) => [
      type,
      v.supports,
    ]),
  );

  for (const skill of skills) {
    describe(`${skill.category}/${skill.name}`, () => {
      const md = loadMarkdown(join(skill.dir, "SKILL.md"));
      const { contract } = skill.files;

      it("SKILL.md frontmatter follows the Agent Skills specification", () => {
        for (const key of Object.keys(md.frontmatter)) {
          assert.ok(AGENT_SKILLS_FIELDS.has(key), `unsupported frontmatter field "${key}"`);
        }
        const { name, description } = md.frontmatter;
        assert.equal(name, skill.name, "name must match the directory");
        assert.match(String(name), NAME);
        assert.ok(String(name).length <= 64);
        assert.equal(typeof description, "string");
        assert.ok((description as string).length > 0 && (description as string).length <= 1024);
      });

      it("SKILL.md has every section of the template", () => {
        const present = headings(md.body, 2);
        for (const section of sections) {
          assert.ok(present.includes(section), `missing section "## ${section}"`);
        }
      });

      it("skill.yaml is valid and consistent with its location", () => {
        const result = schemas().validate(contract);
        assert.ok(result.valid, formatErrors(rel(join(skill.dir, "skill.yaml")), result.errors));
        assert.equal(contract.id, `core.${skill.category}.${skill.name}`);
        assert.equal(contract.category, skill.category);
      });

      it("is small, generic and consistent with its contract", () => {
        assert.deepEqual(assessSkillQuality(skill.files, ruleStatements), []);
      });

      it("requires only check types that can prove something", () => {
        assert.deepEqual(unprovingRequiredChecks(contract, supports), []);
      });

      // Rule, tool and skill references are resolved in tests/core/references.test.ts.
      it("lists exactly the supporting files it has, one level deep", () => {
        const listed = [...(contract.references ?? [])].sort();
        assert.deepEqual(Object.keys(skill.files.supporting).sort(), listed);
        for (const file of listed) assert.ok(existsSync(join(skill.dir, file)), `missing ${file}`);
        const allowed = new Set(["SKILL.md", "skill.yaml", ...SUPPORT_DIRS]);
        for (const entry of readdirSync(skill.dir)) assert.ok(allowed.has(entry), `unexpected ${entry}`);
      });
    });
  }
});

// A fixture skill's skill.yaml states the problems it must produce in `# expect-problem:`
// comments; a valid fixture has none.
describe("skill quality checks", () => {
  const root = at("tests", "fixtures", "skills");

  it("accept the skill template", () => {
    const template = loadMarkdown(at("core", "templates", "skill.md"));
    const files: SkillFiles = {
      contract: loadYaml(at("core", "templates", "skill.yaml")) as SkillContract,
      description: String(template.frontmatter.description),
      body: template.body,
      supporting: {},
    };
    assert.deepEqual(assessSkillQuality(files, ruleStatements), []);
  });

  it("accept valid skills", () => {
    for (const name of subdirectories(join(root, "valid"))) {
      assert.deepEqual(assessSkillQuality(loadSkill(join(root, "valid", name)), ruleStatements), [], name);
    }
  });

  it("report each problem an invalid skill has", () => {
    const names = subdirectories(join(root, "invalid"));
    assert.ok(names.length > 0);
    for (const name of names) {
      const dir = join(root, "invalid", name);
      const expected = [...readFileSync(join(dir, "skill.yaml"), "utf8").matchAll(/^# expect-problem: (.+)$/gm)].map((m) => m[1] ?? "");
      assert.ok(expected.length > 0, `${name} declares no expected problem`);
      const problems = assessSkillQuality(loadSkill(dir), ruleStatements);
      for (const text of expected) {
        assert.ok(problems.some((p) => p.includes(text)), `${name}: expected "${text}" in ${JSON.stringify(problems)}`);
      }
    }
  });

  it("detect dependency cycles, including through optional dependencies", () => {
    const skill = (id: string, required: string[], optional: string[] = []): SkillContract => ({
      id,
      category: "development",
      status: "experimental",
      depends_on: { required, optional },
      verification: { required: [] },
      evidence: { required: [] },
    });
    assert.deepEqual(dependencyCycles([skill("a", ["b"]), skill("b", ["c"]), skill("c", [])]), []);
    assert.deepEqual(dependencyCycles([skill("a", ["b"]), skill("b", [], ["a"])]), ["a -> b -> a"]);
    assert.deepEqual(dependencyCycles([skill("a", ["a"])]), ["a -> a"]);
  });

  it("detect sentences repeated across skills", () => {
    const sentence = "Read every file the change touches before deciding which pattern to follow here.";
    assert.equal(duplicatedSentences([{ id: "a", text: sentence }, { id: "b", text: `Intro.\n\n${sentence}` }]).length, 1);
    assert.deepEqual(duplicatedSentences([{ id: "a", text: sentence }, { id: "b", text: "Something else entirely." }]), []);
  });

  it("flag required check types that prove nothing", () => {
    const contract: SkillContract = {
      id: "project.development.sample",
      category: "development",
      status: "experimental",
      verification: { required: ["build", "unit"] },
      evidence: { required: ["check-result"] },
    };
    assert.deepEqual(unprovingRequiredChecks(contract, new Map([["build", []], ["unit", ["behavior"]]])), ["build"]);
  });
});

// Evidence fixtures name Core skills in `producer.skills`; unsound ones are schema-valid
// but miss a check type or evidence kind those skills require.
describe("evidence against skill contracts", () => {
  const contracts = new Map(coreSkills().map((s) => {
    const contract = loadYaml(join(s.dir, "skill.yaml")) as SkillContract;
    return [contract.id, contract];
  }));
  const root = at("tests", "fixtures", "skill-evidence");
  type Record = Parameters<typeof assessSkillEvidence>[0];

  it("accept records that satisfy their skills", () => {
    for (const file of filesRecursive(join(root, "sound"), (f) => f.endsWith(".yaml"))) {
      const record = loadYaml(file);
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      assert.deepEqual(assessSkillEvidence(record as Record, contracts), [], rel(file));
    }
  });

  it("reject records that do not", () => {
    const files = filesRecursive(join(root, "unsound"), (f) => f.endsWith(".yaml"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const record = loadYaml(file);
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      const expected = /^# expect-problem: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1];
      const problems = assessSkillEvidence(record as Record, contracts);
      assert.ok(expected !== undefined && problems.some((p) => p.includes(expected)), `${rel(file)}: ${JSON.stringify(problems)}`);
    }
  });
});
