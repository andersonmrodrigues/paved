import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseAllDocuments } from "yaml";
import { loadYaml } from "../../cli/lib/documents.ts";
import { indexArtifacts, resolveReferences, type LabeledDocument } from "../../cli/lib/references.ts";
import { at, filesRecursive, rel, schemas } from "../helpers.ts";
import { coreDocuments, coreRules } from "./registries.ts";

const core = coreDocuments();

/** Resolves `documents` against Core plus the documents themselves, as a project's effective set would. */
function resolve(documents: LabeledDocument[]): string[] {
  return resolveReferences(documents, indexArtifacts([...core, ...documents]));
}

function loadAll(file: string): LabeledDocument[] {
  return parseAllDocuments(readFileSync(file, "utf8")).map((doc, index) => ({
    label: `${rel(file)}#${index + 1}`,
    document: doc.toJS() as Record<string, unknown>,
  }));
}

describe("references", () => {
  it("Core content references only Core artifacts that exist", () => {
    assert.deepEqual(resolveReferences(core, indexArtifacts(core)), []);
  });

  it("Core ids are unique per kind", () => {
    for (const kind of ["Rule", "Tool", "ToolImplementation", "Check", "Skill", "Workflow"]) {
      const ids = core.filter(({ document }) => document["kind"] === kind).map(({ document }) => document["id"]);
      assert.equal(new Set(ids).size, ids.length, `duplicate ${kind} id`);
    }
  });

  it("templates reference artifacts that exist", () => {
    const templates = filesRecursive(at("core", "templates"), (f) => f.endsWith(".yaml")).map((file) => ({
      label: rel(file),
      document: loadYaml(file) as Record<string, unknown>,
    }));
    assert.deepEqual(resolve(templates), []);
  });

  it("the overrides template does not target rules that cannot be overridden", () => {
    const overrides = loadYaml(at("core", "templates", "overrides.yaml")) as { rules?: { target: string }[] };
    const locked = coreRules().filter((r) => r.document["overridable"] === false).map((r) => r.document.id);
    for (const entry of overrides.rules ?? []) {
      assert.ok(!locked.includes(entry.target), `${entry.target} is not overridable`);
    }
  });

  const fixtures = at("tests", "fixtures", "references");

  it("valid fixtures resolve", () => {
    for (const file of filesRecursive(join(fixtures, "valid"), (f) => f.endsWith(".yaml"))) {
      const documents = loadAll(file);
      for (const { label, document } of documents) {
        const result = schemas().validate(document);
        assert.ok(result.valid, `${label}: ${result.errors.join("; ")}`);
      }
      assert.deepEqual(resolve(documents), [], rel(file));
    }
  });

  it("invalid fixtures are structurally valid but fail resolution for the stated reason", () => {
    const files = filesRecursive(join(fixtures, "invalid"), (f) => f.endsWith(".yaml"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const expected = /^# expect-error: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
      assert.ok(expected, `${rel(file)} must declare "# expect-error: <text>"`);
      const documents = loadAll(file);
      for (const { label, document } of documents) {
        const result = schemas().validate(document);
        assert.ok(result.valid, `${label}: ${result.errors.join("; ")}`);
      }
      const problems = resolve(documents);
      assert.ok(
        problems.some((problem) => problem.includes(expected)),
        `${rel(file)}: no problem contains "${expected}"\n  ${problems.join("\n  ")}`,
      );
    }
  });
});
