import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readyTasks, validateDelegationPlan, type DelegationPlan } from "../../cli/lib/delegation.ts";
import { at } from "../helpers.ts";

function plan(): DelegationPlan {
  return {
    apiVersion: "paved/v1", kind: "DelegationPlan", id: "feature-20261023-dag", run: "feature-20261023-dag",
    plan_sha256: "a".repeat(64), max_concurrency: 2,
    tasks: [
      { id: "research", title: "Research", brief: "Inspect modules", depends_on: [], read_paths: ["cli/"], write_paths: [], output_contract: "Report paths", model_policy: { capacity: "economy", reasoning_effort: "low", rationale: "Narrow task" } },
      { id: "build", title: "Build", brief: "Implement change", depends_on: ["research"], read_paths: ["cli/"], write_paths: ["cli/new.ts"], output_contract: "Code and checks", model_policy: { capacity: "frontier", reasoning_effort: "high", rationale: "Complex task" } },
      { id: "docs", title: "Docs", brief: "Document change", depends_on: [], read_paths: ["docs/"], write_paths: ["docs/new.md"], output_contract: "Updated docs", model_policy: { capacity: "balanced", reasoning_effort: "medium", rationale: "Independent writing" } },
    ],
  };
}

describe("delegation plans", () => {
  it("validates an acyclic graph and returns only dependency-ready tasks", () => {
    const graph = plan();
    validateDelegationPlan(at("."), graph);
    assert.deepEqual(readyTasks(graph).map(({ id }) => id), ["research", "docs"]);
    graph.tasks[0]!.status = "completed";
    assert.deepEqual(readyTasks(graph).map(({ id }) => id), ["build", "docs"]);
  });

  it("rejects cycles and overlapping concurrent writes", () => {
    const cyclic = plan();
    cyclic.tasks[0]!.depends_on = ["build"];
    assert.throws(() => validateDelegationPlan(at("."), cyclic), /cycle/);

    const overlapping = plan();
    overlapping.tasks[2]!.write_paths = ["cli/new.ts/child"];
    assert.throws(() => validateDelegationPlan(at("."), overlapping), /both write/);
  });

  it("rejects glob write scopes and writes to Paved state", () => {
    const glob = plan();
    glob.tasks[0]!.write_paths = ["src/**"];
    assert.throws(() => validateDelegationPlan(at("."), glob), /glob/);
    const state = plan();
    state.tasks[0]!.write_paths = [".paved/generated/runs/run.yaml"];
    assert.throws(() => validateDelegationPlan(at("."), state), /Paved run state/);
  });

  it("validates bounded experiment alternatives with identical scope", () => {
    const graph = plan();
    const base = graph.tasks[1]!;
    base.depends_on = [];
    graph.tasks = [
      { ...base, id: "baseline", experiment: { group: "probe", role: "baseline" } },
      { ...base, id: "candidate-a", experiment: { group: "probe", role: "candidate", changes: [{ id: "prompt-tightening", target: "prompt", rationale: "Clarify the output boundary" }] } },
    ];
    validateDelegationPlan(at("."), graph);
    graph.tasks[1]!.write_paths = ["docs/new.md"];
    assert.throws(() => validateDelegationPlan(at("."), graph), /share dependencies and read\/write scopes/);
  });

  it("rejects experiment groups without exactly one baseline and a candidate", () => {
    const graph = plan();
    const base = graph.tasks[1]!;
    base.depends_on = [];
    graph.tasks = [
      { ...base, id: "candidate-a", experiment: { group: "probe", role: "candidate", changes: [{ id: "variant", target: "skill", rationale: "Try a focused procedure" }] } },
      { ...base, id: "candidate-b", experiment: { group: "probe", role: "candidate", changes: [{ id: "variant-2", target: "skill", rationale: "Try another focused procedure" }] } },
    ];
    assert.throws(() => validateDelegationPlan(at("."), graph), /exactly one baseline/);
  });
});
