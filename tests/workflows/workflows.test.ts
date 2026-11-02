import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as workflowModule from "../../cli/lib/workflows.ts";
import { loadContract } from "../../cli/lib/workflow-runs.ts";
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
  type WorkflowFragmentContract,
  type WorkflowFragmentMetadata,
  type WorkflowPhase,
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
    for (const name of ["feature", "bug", "refactor"]) {
      assert.ok(names.includes(name), `missing workflow ${name}`);
    }
  });

  it("do not ship workflows that nothing executes", () => {
    for (const name of ["performance", "incident", "release"]) {
      assert.ok(!names.includes(name), `workflow ${name} was removed in 2.0`);
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

  it("defines the durable work-document paths and canonical preview plan path", () => {
    const instructions = loadMarkdown(at("core", "instructions", "workflows.md")).body;
    for (const category of ["intents", "plans", "specs", "tasks", "research"]) {
      assert.match(instructions, new RegExp(`\\.paved/documents/${category}/<run-id>\\.md`), category);
    }
    assert.match(instructions, /paved preview start \.paved\/documents\/plans\/<run-id>\.md/);
    assert.ok(instructions.includes("plan path recorded in its existing"));
    assert.match(instructions, /plan starts from the run's Intent document and\s+links to it/);
  });

  it("activates frontend design guidance in user-facing change workflows", () => {
    const skill = "core.development.frontend-design";
    for (const id of ["core.feature", "core.bug"]) {
      const workflow = coreWorkflows.get(id)!;
      for (const phaseName of ["planning", "implementation"]) {
        const phase = workflow.phases.find((item) => item.phase === phaseName);
        assert.ok(phase?.skills?.includes(skill), `${id} ${phaseName}`);
      }
    }
  });

  for (const name of names) {
    describe(name, () => {
      const dir = join(root, name);
      const files = loadWorkflow(dir);

      it("workflow.yaml is valid and identified by its directory", () => {
        const result = schemas().validate(loadYaml(join(dir, "workflow.yaml")));
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

describe("workflow run decisions", () => {
  const workflow = {
    id: "core.feature", version: "1.0.0", status: "active", description: "Use when …",
    change_type: "feature", inputs: [{ id: "request", required: true }],
    phases: [{ phase: "context", goal: "g" }],
    evidence: { required: [] }, outputs: [], completion: { criteria: [] },
  } as never;

  const baseRun = {
    workflow: { id: "core.feature", version: "1.0.0" },
    status: "running",
    inputs: [{ id: "request" }],
    phases: [{ phase: "context", status: "running" }],
  };

  it("allows awaiting-input when a decision is ASKED", () => {
    const run = {
      ...baseRun, status: "awaiting-input",
      decisions: [{ id: "d-0123456789abcdef0123", status: "ASKED", required: true }],
    } as never;
    assert.deepEqual(assessRun(run, workflow), []);
  });

  it("rejects awaiting-input with no ASKED decision", () => {
    const run = {
      ...baseRun, status: "awaiting-input",
      decisions: [{ id: "d-0123456789abcdef0123", status: "APPLIED", required: true }],
    } as never;
    assert.ok(assessRun(run, workflow).some((problem) => /awaiting input/i.test(problem)));
  });

  it("rejects running while a required decision is unanswered", () => {
    const run = {
      ...baseRun, status: "running",
      decisions: [{ id: "d-0123456789abcdef0123", status: "ASKED", required: true }],
    } as never;
    assert.ok(assessRun(run, workflow).some((problem) => /unanswered required decision/i.test(problem)));
  });

  it("allows running while only an optional decision is open", () => {
    const run = {
      ...baseRun, status: "running",
      decisions: [{ id: "d-0123456789abcdef0123", status: "ASKED", required: false }],
    } as never;
    assert.deepEqual(assessRun(run, workflow), []);
  });
});


describe("workflow fragment resolution", () => {
  const fixture = loadYaml(at("tests", "fixtures", "workflows", "fragments", "cases.yaml")) as {
    fragment: WorkflowFragmentContract;
    cases: { name: string; inclusions: NonNullable<WorkflowPhase["fragments"]>; metadata?: Partial<WorkflowFragmentMetadata>; body?: string; problem?: string }[];
  };
  // Removing interpolation or any validation branch must break its hand-written fixture.
  for (const item of fixture.cases) {
    it(item.name, () => {
      const resolver = Reflect.get(workflowModule, "resolveWorkflowFragments");
      assert.equal(typeof resolver, "function", "workflow fragment resolution is implemented");
      const fragment = { contract: { ...fixture.fragment.contract, ...item.metadata }, body: item.body ?? fixture.fragment.body };
      const workflow = { ...coreWorkflows.get("core.feature")!, phases: [{ phase: "discovery", goal: "Locate patterns.", fragments: item.inclusions }] };
      const result = resolver(workflow, new Map([[fragment.contract["id"], fragment]]));
      if (item.problem) {
        assert.ok(result.problems.some((problem: string) => problem.includes(item.problem!)), JSON.stringify(result));
        assert.deepEqual(result.phases, [], "invalid guidance must not reach execution");
      } else {
        assert.deepEqual(result.problems, []);
        assert.equal(result.phases[0]!.fragments![0]!.body, "Locate payment rules. Return paths and findings.\n");
        assert.deepEqual(result.phases[0]!.skills, ["core.discovery.context-discovery"]);
        assert.deepEqual(result.phases[0]!.tools!.required, ["core.repository.search"]);
        assert.equal(workflow.phases[0]!.fragments, item.inclusions, "source contract stays unchanged");
      }
    });
  }

  it("applies skill limits and destructive tool gates after composition", () => {
    const resolver = Reflect.get(workflowModule, "resolveWorkflowFragments");
    assert.equal(typeof resolver, "function");
    const workflow = { ...coreWorkflows.get("core.feature")!, phases: [{ phase: "discovery", goal: "Locate patterns.",
      skills: ["core.testing.unit-testing", "core.testing.integration-testing", "core.testing.e2e-testing"],
      fragments: [{ id: "core.fragment.sample", with: { subject: "payment rules" } }] }] };
    const fragment = { ...fixture.fragment, contract: { ...fixture.fragment.contract, tools: ["project.data.purge"] } };
    const resolved = resolver(workflow, new Map([["core.fragment.sample", fragment]]));
    assert.deepEqual(resolved.problems, []);
    const problems = assessWorkflowQuality({ contract: { ...workflow, phases: resolved.phases }, body: "project.data.purge" }, {
      ...context, toolSafety: new Map([...context.toolSafety, ["project.data.purge", "destructive"]]),
    });
    assert.ok(problems.some((problem) => problem.includes("more than 3 skills")), JSON.stringify(problems));
    assert.ok(problems.some((problem) => problem.includes("without an approval gate")), JSON.stringify(problems));
  });

  it("checks required skill dependencies introduced by a fragment", () => {
    const resolver = Reflect.get(workflowModule, "resolveWorkflowFragments");
    assert.equal(typeof resolver, "function");
    const workflow = { ...coreWorkflows.get("core.feature")!, phases: [{ phase: "discovery", goal: "Locate patterns.",
      skills: ["project.testing.parent"], fragments: [{ id: "core.fragment.sample", with: { subject: "rules" } }] }] };
    const resolved = resolver(workflow, new Map([["core.fragment.sample", fixture.fragment]]));
    assert.deepEqual(resolved.problems, []);
    const dependencyContext = { ...context, skills: new Map([...context.skills, ["project.testing.parent", {
      ...context.skills.get("core.discovery.context-discovery")!, id: "project.testing.parent",
      depends_on: { required: ["core.discovery.context-discovery"] },
    }]]) };
    const problems = assessWorkflowQuality({ contract: { ...workflow, phases: resolved.phases }, body: "core.repository.search" }, dependencyContext);
    assert.ok(problems.some((problem) => problem.includes("core.discovery.context-discovery, which another listed skill already activates")), JSON.stringify(problems));
  });

  it("loads feature 0.5.0 with its effective context-discovery fragment before execution", () => {
    const contract = loadContract(at(), "core.feature");
    assert.equal(contract.version, "0.5.0", "adding discovery fragment guidance changes the effective workflow version");
    const discovery = contract.phases.find((phase) => phase.phase === "discovery")!;
    const fragments = Reflect.get(discovery, "fragments");
    assert.ok(fragments?.length, "Core feature workflow consumes context-discovery fragment");
    assert.equal(fragments[0]!.body, "Find the sibling feature closest to this one; it is the pattern that\n`core.architecture.follow-existing-patterns` asks you to follow.\n");
  });

  it("rejects malformed fragment metadata and unknown fragment references while loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "paved-fragments-"));
    try {
      cpSync(at("schemas"), join(dir, "schemas"), { recursive: true });
      cpSync(at("core"), join(dir, "core"), { recursive: true });
      const file = join(dir, "core/workflow-fragments/context-discovery/fragment.yaml");
      assert.ok(Reflect.get(loadContract(dir, "core.feature").phases[1]!, "fragments")?.length);
      const metadata = readFileSync(file, "utf8");
      writeFileSync(file, metadata + "fragments: [core.fragment.context-discovery]\n");
      assert.throws(() => loadContract(dir, "core.feature"), /invalid|nested/);
      writeFileSync(file, metadata.replace("core.discovery.context-discovery", "core.discovery.unknown"));
      assert.throws(() => loadContract(dir, "core.feature"), /unknown skill/);
      writeFileSync(file, metadata.replace("tools: []", "tools: [core.repository.unknown]"));
      assert.throws(() => loadContract(dir, "core.feature"), /unknown tool/);
      writeFileSync(file, metadata);
      const workflowFile = join(dir, "core/workflows/feature/workflow.yaml");
      writeFileSync(workflowFile, readFileSync(workflowFile, "utf8").replace("core.fragment.context-discovery", "core.fragment.unknown"));
      assert.throws(() => loadContract(dir, "core.feature"), /unknown fragment/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe("phase-scoped Tool policies", () => {
  const files = loadWorkflow(join(root, "feature"));
  const assess = (policies: unknown[], phasePolicies: string[], phaseTools?: WorkflowPhase["tools"]) => {
    const contract = structuredClone(files.contract);
    Object.assign(contract, { tool_policies: policies });
    const phase = contract.phases.find((item) => item.phase === "discovery")!;
    Object.assign(phase, { tool_policies: phasePolicies });
    if (phaseTools) phase.tools = phaseTools;
    return assessWorkflowQuality({ contract, body: files.body + " core.repository.status core.repository.diff" }, context);
  };
  const policy = (id: string, actions = {}) => ({ id, allow: [], ask: [], deny: [], ...actions });

  it("rejects unknown policy ids and duplicate policy definitions", () => {
    assert.ok(assess([], ["missing"]).some((p) => p.includes("unknown tool policy missing")));
    assert.ok(assess([policy("safe"), policy("safe")], []).some((p) => p.includes("duplicate tool policy safe")));
  });

  for (const action of ["allow", "ask", "deny"]) {
    it(`resolves unknown Tools in ${action}, even in an unselected policy`, () => {
      const problems = assess([policy("safe", { [action]: ["core.repository.missing"] })], []);
      assert.ok(problems.some((p) => p.includes("unknown tool core.repository.missing")), JSON.stringify(problems));
    });
  }

  for (const actions of [["allow", "ask"], ["allow", "deny"], ["ask", "deny"]]) {
    it(`rejects conflicting ${actions.join("/")} actions within a policy`, () => {
      const problems = assess([policy("safe", Object.fromEntries(actions.map((a) => [a, ["core.repository.diff"]])))], ["safe"]);
      assert.ok(problems.some((p) => p.includes("conflicting actions") && p.includes("core.repository.diff")), JSON.stringify(problems));
    });
    it(`rejects conflicting ${actions.join("/")} actions across selected policies`, () => {
      const problems = assess(actions.map((a) => policy(a, { [a]: ["core.repository.diff"] })), actions);
      assert.ok(problems.some((p) => p.includes("conflicting actions") && p.includes("phase discovery")), JSON.stringify(problems));
    });
  }

  it("accepts repeated same-action Tools and policies isolated to other phases", () => {
    assert.deepEqual(assess([policy("first", { ask: ["core.repository.diff"] }), policy("second", { ask: ["core.repository.diff"] }),
      policy("unused", { deny: ["core.repository.diff"] })], ["first", "second"]), []);
  });

  it("rejects denying a directly required Tool", () => {
    const problems = assess([policy("safe", { deny: ["core.repository.status"] })], ["safe"], { required: ["core.repository.status"] });
    assert.ok(problems.some((p) => p.includes("required tool core.repository.status is denied")), JSON.stringify(problems));
  });

  it("rejects denying a Tool required by a fragment", () => {
    const contract = structuredClone(files.contract);
    Object.assign(contract, { tool_policies: [policy("safe", { deny: ["core.repository.status"] })] });
    const phase = contract.phases.find((item) => item.phase === "discovery")!;
    Object.assign(phase, { tool_policies: ["safe"], fragments: [{ id: "core.fragment.test" }] });
    const resolved = workflowModule.resolveWorkflowFragments(contract, new Map([["core.fragment.test", {
      contract: { apiVersion: "paved/v1", kind: "WorkflowFragment", id: "core.fragment.test", title: "Test", version: "0.1.0", status: "experimental", inputs: [], skills: [], tools: ["core.repository.status"] }, body: "Inspect status.",
    }]]));
    assert.deepEqual(resolved.problems, []);
    const problems = assessWorkflowQuality({ contract: { ...contract, phases: resolved.phases }, body: files.body + " core.repository.status" }, context);
    assert.ok(problems.some((p) => p.includes("required tool core.repository.status is denied")), JSON.stringify(problems));
  });

  it("rejects denying a Tool required by an active skill dependency", () => {
    const contract = structuredClone(files.contract);
    Object.assign(contract, { tool_policies: [policy("safe", { deny: ["core.repository.status"] })] });
    Object.assign(contract.phases.find((item) => item.phase === "discovery")!, { tool_policies: ["safe"], skills: ["project.discovery.parent"] });
    const skills = new Map(context.skills);
    skills.set("project.discovery.parent", { ...context.skills.get("core.discovery.context-discovery")!, id: "project.discovery.parent", tools: {}, depends_on: { required: ["project.discovery.child"] } });
    skills.set("project.discovery.child", { ...context.skills.get("core.discovery.context-discovery")!, id: "project.discovery.child", tools: { required: ["core.repository.status"] } });
    const problems = assessWorkflowQuality({ contract, body: files.body }, { ...context, skills });
    assert.ok(problems.some((p) => p.includes("required tool core.repository.status is denied")), JSON.stringify(problems));
  });
});
