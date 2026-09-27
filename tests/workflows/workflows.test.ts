import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { headings, loadMarkdown, loadYaml } from "../../cli/lib/documents.ts";
import {
  assessRun,
  assessWorkflowEvidence,
  assessWorkflowQuality,
  FAILURE_CODES,
  type WorkflowContract,
  type WorkflowRunRecord,
} from "../../cli/lib/workflows.ts";
import { at, filesRecursive, formatErrors, rel, schemas, subdirectories } from "../helpers.ts";
import { CANONICAL_ORDER, coreWorkflowContext, loadWorkflow } from "./context.ts";

const expectedProblems = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/^# expect-problem: (.+)$/gm)].map((m) => m[1] ?? "");

const context = coreWorkflowContext();
const root = at("core", "workflows");
const names = subdirectories(root);
const coreWorkflows = new Map(names.map((name) => {
  const contract = loadWorkflow(join(root, name)).contract;
  return [contract.id, contract];
}));

describe("core workflows", () => {
  const sections = headings(loadMarkdown(at("core", "templates", "workflow.md")).body, 2);

  it("include every workflow the Core promises", () => {
    for (const name of ["feature", "bug", "refactor", "performance", "incident", "release"]) {
      assert.ok(names.includes(name), `missing workflow ${name}`);
    }
  });

  it("cover each change type at most once", () => {
    const types = [...coreWorkflows.values()].map((w) => w.change_type);
    assert.equal(new Set(types).size, types.length);
  });

  it("document the schema's phase order in lifecycle.md", () => {
    const lifecycle = loadMarkdown(at("core", "instructions", "lifecycle.md")).body;
    const documented = [...lifecycle.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(documented, CANONICAL_ORDER);
  });

  it("document every failure code in workflows.md", () => {
    const text = loadMarkdown(at("core", "instructions", "workflows.md")).body;
    for (const code of Object.keys(FAILURE_CODES)) assert.match(text, new RegExp(`\`${code}\``), code);
    const common = loadYaml(at("schemas", "common.schema.yaml")) as { $defs: { failureCode: { enum: string[] } } };
    assert.deepEqual(Object.keys(FAILURE_CODES).sort(), [...common.$defs.failureCode.enum].sort());
  });

  for (const name of names) {
    describe(name, () => {
      const dir = join(root, name);
      const files = loadWorkflow(dir);

      it("workflow.yaml is valid and identified by its directory", () => {
        const result = schemas().validate(files.contract);
        assert.ok(result.valid, formatErrors(rel(join(dir, "workflow.yaml")), result.errors));
        assert.equal(files.contract.id, `core.${name}`);
      });

      // Skill, tool and rule references are resolved in tests/core/references.test.ts.
      it("is ordered, safe, verifiable and does not duplicate skills", () => {
        assert.deepEqual(assessWorkflowQuality(files, context), []);
      });

      it("WORKFLOW.md has every required section", () => {
        const present = headings(files.body, 2);
        for (const section of sections) {
          assert.ok(present.includes(section), `missing section "## ${section}"`);
        }
      });
    });
  }
});

// Fixture workflows state the problems they must produce in `# expect-problem:` comments.
// `project.data.purge` stands for a destructive project tool.
describe("workflow quality checks", () => {
  const fixtures = at("tests", "fixtures", "workflows");
  const withFixtureTools = { ...context, toolSafety: new Map([...context.toolSafety, ["project.data.purge", "destructive"]]) };

  it("accept the workflow template", () => {
    const files = {
      contract: loadYaml(at("core", "templates", "workflow.yaml")) as WorkflowContract,
      body: loadMarkdown(at("core", "templates", "workflow.md")).body,
    };
    assert.deepEqual(assessWorkflowQuality(files, context), []);
  });

  it("accept valid workflows", () => {
    for (const name of subdirectories(join(fixtures, "valid"))) {
      const files = loadWorkflow(join(fixtures, "valid", name));
      const result = schemas().validate(files.contract);
      assert.ok(result.valid, formatErrors(name, result.errors));
      assert.deepEqual(assessWorkflowQuality(files, withFixtureTools), [], name);
    }
  });

  it("report each problem an invalid workflow has", () => {
    const invalid = subdirectories(join(fixtures, "invalid"));
    assert.ok(invalid.length > 0);
    for (const name of invalid) {
      const dir = join(fixtures, "invalid", name);
      const expected = expectedProblems(join(dir, "workflow.yaml"));
      assert.ok(expected.length > 0, `${name} declares no expected problem`);
      const files = loadWorkflow(dir);
      const result = schemas().validate(files.contract);
      assert.ok(result.valid, formatErrors(name, result.errors));
      const problems = assessWorkflowQuality(files, withFixtureTools);
      for (const text of expected) {
        assert.ok(problems.some((p) => p.includes(text)), `${name}: expected "${text}" in ${JSON.stringify(problems)}`);
      }
    }
  });
});

// Run fixtures are checked against the Core workflow they name.
describe("workflow runs", () => {
  const fixtures = at("tests", "fixtures", "workflow-runs");
  const assess = (file: string) => {
    const run = loadYaml(file) as WorkflowRunRecord;
    const result = schemas().validate(run);
    assert.ok(result.valid, formatErrors(rel(file), result.errors));
    const workflow = coreWorkflows.get(run.workflow.id);
    assert.ok(workflow, `${rel(file)} names unknown workflow ${run.workflow.id}`);
    return assessRun(run, workflow);
  };

  it("accept consistent runs", () => {
    for (const file of filesRecursive(join(fixtures, "sound"), (f) => f.endsWith(".yaml"))) {
      assert.deepEqual(assess(file), [], rel(file));
    }
  });

  it("reject runs that contradict their workflow", () => {
    const files = filesRecursive(join(fixtures, "unsound"), (f) => f.endsWith(".yaml"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const expected = expectedProblems(file);
      assert.ok(expected.length > 0, `${rel(file)} declares no expected problem`);
      const problems = assess(file);
      for (const text of expected) {
        assert.ok(problems.some((p) => p.includes(text)), `${rel(file)}: expected "${text}" in ${JSON.stringify(problems)}`);
      }
    }
  });

  it("map every failure code to a run status and retry class the schema allows", () => {
    const common = loadYaml(at("schemas", "common.schema.yaml")) as { $defs: { retryClass: { enum: string[] } } };
    for (const [code, { retry }] of Object.entries(FAILURE_CODES)) {
      assert.ok(common.$defs.retryClass.enum.includes(retry), code);
    }
  });
});

// Evidence fixtures are all checked against core.bug.
describe("evidence against workflow contracts", () => {
  const fixtures = at("tests", "fixtures", "workflow-evidence");
  const bug = coreWorkflows.get("core.bug")!;
  type Record = Parameters<typeof assessWorkflowEvidence>[0];

  it("accept records that satisfy the workflow", () => {
    for (const file of filesRecursive(join(fixtures, "sound"), (f) => f.endsWith(".yaml"))) {
      const record = loadYaml(file);
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      assert.deepEqual(assessWorkflowEvidence(record as Record, bug), [], rel(file));
    }
  });

  it("reject records that do not", () => {
    const files = filesRecursive(join(fixtures, "unsound"), (f) => f.endsWith(".yaml"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const record = loadYaml(file);
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      const problems = assessWorkflowEvidence(record as Record, bug);
      for (const text of expectedProblems(file)) {
        assert.ok(problems.some((p) => p.includes(text)), `${rel(file)}: expected "${text}" in ${JSON.stringify(problems)}`);
      }
    }
  });
});
