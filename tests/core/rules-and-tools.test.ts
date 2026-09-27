import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateImplementation, validateTool, type ToolContract, type ToolImplementation } from "../../cli/lib/tools.ts";
import { formatErrors, rel, schemas } from "../helpers.ts";
import { coreRules, coreToolImplementations, coreTools, type IdentifiedDocument } from "./registries.ts";

function checkDocuments(label: string, documents: IdentifiedDocument[]) {
  it(`${label} are valid and their ids match their paths`, () => {
    assert.ok(documents.length > 0, `no ${label}`);
    for (const { file, expectedId, document } of documents) {
      const result = schemas().validate(document);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      assert.equal(document.id, expectedId, rel(file));
    }
  });
}

describe("core rules", () => {
  checkDocuments("rules", coreRules());

  it("cover every Core category", () => {
    const categories = new Set(coreRules().map((r) => r.expectedId.split(".")[1]));
    for (const category of ["architecture", "security", "quality", "testing", "performance"]) {
      assert.ok(categories.has(category), `no rule in ${category}`);
    }
  });
});

describe("core tools", () => {
  checkDocuments("tools", coreTools());
  checkDocuments("tool implementations", coreToolImplementations());

  it("keeps capability and implementation contracts consistent", () => {
    const tools = new Map(coreTools().map(({ document }) => [document.id, document as unknown as ToolContract]));
    for (const tool of tools.values()) assert.deepEqual(validateTool(tool), [], tool.id);
    for (const { document } of coreToolImplementations()) {
      const implementation = document as unknown as ToolImplementation;
      const tool = tools.get(implementation.tool);
      assert.ok(tool, `${implementation.id} references an unknown Tool`);
      assert.deepEqual(validateImplementation(implementation, tool), [], implementation.id);
    }
  });
});
