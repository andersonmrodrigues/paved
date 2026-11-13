import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { detectAdapters, loadAdapters } from "../../cli/lib/adapters.ts";
import { discoverSources } from "../../cli/lib/generator-runtime.ts";
import {
  authorizeTool, buildArgv, compatible, resolveTool, retryDecision, validateImplementation, validateTool,
  type ToolContract, type ToolImplementation,
} from "../../cli/lib/tools.ts";
import { at, cleanupTemporaryDirectories, coreManifest, filesRecursive, formatErrors, rel, schemas, temporaryDirectory } from "../helpers.ts";

const root = at("adapters", "infrastructure", "github");
const NAMES = ["open", "status", "merge"] as const;
const tool = (name: string) => loadYaml(at("core", "tools", "change-request", `${name}.yaml`)) as ToolContract;
const HEAD = "4f2c9e1b7a3d8c21e5f60a9b2d4c6e8f01a3b5c7";
afterEach(cleanupTemporaryDirectories);

function detection(files: Record<string, string>) {
  const project = temporaryDirectory("paved-github");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  return detectAdapters(project, loadAdapters(at()), discoverSources(project)).find((item) => item.adapter.id === "infrastructure/github")!;
}

describe("change-request Tool contracts", () => {
  it("are technology-neutral, valid and classified by their effect on the shared repository", () => {
    const tools = Object.fromEntries(NAMES.map((name) => [name, tool(name)]));
    for (const contract of Object.values(tools)) {
      assert.deepEqual(validateTool(contract), [], contract.id);
      assert.ok(schemas().validate(contract).valid, contract.id);
    }
    assert.equal(tools.status!.safety, "read-only");
    assert.equal(tools.open!.safety, "high-impact");
    assert.equal(tools.open!.confirmation, "required");
    assert.equal(tools.merge!.safety, "destructive");
    assert.equal(tools.merge!.confirmation, "required");
    assert.equal(tools.merge!.retry.max_attempts, 1);
    assert.equal(retryDecision(tools.merge!, "transient-failure", 1).retry, false);
    assert.ok(tools.merge!.inputs.find((input) => input.name === "head")?.required, "merge must pin the head revision it was checked against");
    const neutral = filesRecursive(at("core", "tools", "change-request"), () => true)
      .filter((file) => /\b(gh|github|pull request)\b/i.test(readFileSync(file, "utf8"))).map(rel);
    assert.deepEqual(neutral, []);
  });

  it("never lets an agent, Paved or CI stand in for the human who confirms a merge", () => {
    const merge = tool("merge");
    const context = {
      environment: "local", permissions: merge.permissions,
      preconditions: Object.fromEntries(merge.preconditions.map((precondition) => [precondition.id, true])),
    };
    for (const approver of ["agent", "paved", "ci"]) {
      assert.equal(authorizeTool(merge, { ...context, approval: { approved_by: approver } }).allowed, false, approver);
    }
    assert.equal(authorizeTool(merge, context).allowed, false);
    assert.equal(authorizeTool(merge, { ...context, approval: { approved_by: "maintainer@example.com" } }).allowed, true);
    assert.equal(authorizeTool(merge, { ...context, preconditions: { ...context.preconditions, "evidence-current": false }, approval: { approved_by: "maintainer@example.com" } }).allowed, false);
  });
});

describe("GitHub adapter", () => {
  it("binds the three Core change-request capabilities to the GitHub CLI", () => {
    const tools = NAMES.map(tool);
    const adapter = loadYaml(join(root, "adapter.yaml")) as { requires: { core: string }; provides: { tools?: string[]; tool_implementations: string[] }; sources: { url: string; retrieved_at: string }[] };
    const valid = schemas().validate(adapter);
    assert.ok(valid.valid, formatErrors("adapter.yaml", valid.errors));
    assert.ok(compatible(coreManifest().version, adapter.requires.core));
    assert.equal(adapter.provides.tools, undefined, "adapter bindings must not duplicate Core Tool contracts");
    assert.ok(adapter.sources.every((source) => source.url.startsWith("https://") && source.retrieved_at));
    const implementations = adapter.provides.tool_implementations.map((path) => {
      const binding = loadYaml(join(root, path)) as ToolImplementation;
      const result = schemas().validate(binding);
      assert.ok(result.valid, formatErrors(path, result.errors));
      assert.equal(binding.source, "adapter");
      assert.match(binding.id, /^adapter-github\.change-request\./);
      assert.equal(binding.invocation.executable, "gh");
      return binding;
    });
    assert.equal(implementations.length, 3);
    for (const contract of tools) {
      assert.deepEqual(validateImplementation(implementations.find((item) => item.tool === contract.id)!, contract), []);
      const resolution = resolveTool(contract.id, [contract], implementations, "local");
      assert.equal(resolution.status, "resolved", contract.id);
      assert.match(resolution.implementation?.id ?? "", /^adapter-github\./);
      assert.match(resolveTool(contract.id, [contract], [], "local").reason ?? "", /no compatible implementation/);
      assert.equal(resolveTool(contract.id, [contract], implementations, "production").status, "blocked");
    }
  });

  it("merges only the head revision that was checked, as one squashed patch", () => {
    const merge = tool("merge");
    const binding = loadYaml(join(root, "tool-implementations/change-request/merge.yaml")) as ToolImplementation;
    assert.deepEqual(buildArgv(merge, binding, { change: "42", head: HEAD }), {
      executable: "gh", argv: ["pr", "merge", "--squash", "42", "--match-head-commit", HEAD],
    });
    assert.throws(() => buildArgv(merge, binding, { change: "42" }), /required input head is missing/);
    assert.throws(() => buildArgv(merge, binding, { change: "--admin", head: HEAD }), /does not match its pattern/);
    const open = loadYaml(join(root, "tool-implementations/change-request/open.yaml")) as ToolImplementation;
    assert.deepEqual(buildArgv(tool("open"), open, { title: "Export archived items", body: "Verified.", base: "main", draft: true }).argv,
      ["pr", "create", "--title", "Export archived items", "--body", "Verified.", "--base", "main", "--draft"]);
  });

  it("is proposed by GitHub Actions workflow content, not by a file name alone", () => {
    const workflow = "name: check\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n";
    const detected = detection({ ".github/workflows/check.yml": workflow });
    assert.equal(detected.confidence, "medium");
    assert.deepEqual(detected.evidence, [".github/workflows/check.yml"]);
    assert.equal(detection({ ".github/workflows/notes.yml": "# nothing here\n" }).confidence, "unknown");
    assert.equal(detection({ "ci/check.yml": workflow }).confidence, "unknown");
  });
});
