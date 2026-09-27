import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { compatible, resolveTool, validateImplementation, type ToolContract, type ToolImplementation } from "../../cli/lib/tools.ts";
import { at, coreManifest, filesRecursive, formatErrors, rel, schemas } from "../helpers.ts";

const root = at("adapters", "infrastructure", "git");

describe("Git adapter boundary", () => {
  it("keeps Git commands and Git-specific references out of Core", () => {
    const offenders = filesRecursive(at("core"), (file) => /\.(yaml|md)$/.test(file))
      .filter((file) => /\bgit\b|core\.git\./i.test(readFileSync(file, "utf8")))
      .map(rel);
    assert.deepEqual(offenders, []);
  });

  it("binds the three Core repository capabilities through an adapter", () => {
    const tools = ["status", "diff", "history"].map((name) =>
      loadYaml(at("core", "tools", "repository", `${name}.yaml`)) as ToolContract,
    );
    const adapter = loadYaml(join(root, "adapter.yaml")) as { requires: { core: string }; provides: { tools?: string[]; tool_implementations: string[] } };
    assert.ok(schemas().validate(adapter).valid);
    assert.ok(compatible(coreManifest().version, adapter.requires.core));
    assert.equal(adapter.provides.tools, undefined, "adapter bindings must not duplicate Core Tool contracts");
    assert.equal(adapter.provides.tool_implementations.length, 3);
    const implementations = adapter.provides.tool_implementations.map((path) => {
      const binding = loadYaml(join(root, path)) as ToolImplementation;
      const valid = schemas().validate(binding);
      assert.ok(valid.valid, formatErrors(path, valid.errors));
      assert.equal(binding.source, "adapter");
      assert.match(binding.id, /^adapter-git\./);
      assert.equal(binding.invocation.executable, "git");
      return binding;
    });
    for (const tool of tools) {
      assert.deepEqual(validateImplementation(implementations.find((item) => item.tool === tool.id)!, tool), []);
      const resolution = resolveTool(tool.id, [tool], implementations, "local");
      assert.equal(resolution.status, "resolved");
      assert.match(resolution.implementation?.id ?? "", /^adapter-git\./);
      assert.equal(resolveTool(tool.id, [tool], [], "local").status, "blocked");
      assert.match(resolveTool(tool.id, [tool], [], "local").reason ?? "", /no compatible implementation/);
      assert.equal(resolveTool(tool.id, [tool], implementations, "production").status, "blocked");
    }
    assert.match(resolveTool(tools[0]!.id, [tools[0]!], [implementations[0]!, {...implementations[0]!, id: "adapter-other.repository.status", source: "adapter"}], "local").reason ?? "", /ambiguous/);
  });
});
