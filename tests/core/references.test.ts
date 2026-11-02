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
    for (const kind of ["Rule", "Tool", "ToolImplementation", "Check", "Skill", "Workflow", "WorkflowFragment"]) {
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


describe("workflow fragment references", () => {
  it("indexes fragments and checks workflow inclusions and fragment dependencies", () => {
    const fragment = { label: "fragment", document: { kind: "WorkflowFragment", id: "core.fragment.sample", skills: ["core.discovery.missing"], tools: ["core.repository.missing"] } };
    const workflow = { label: "workflow", document: { kind: "Workflow", id: "core.sample", phases: [{ phase: "discovery", fragments: [{ id: "core.fragment.missing" }] }] } };
    const documents = [fragment, workflow];
    const index = indexArtifacts(documents);
    assert.ok(index.get("workflow-fragment")?.has("core.fragment.sample"));
    const problems = resolveReferences(documents, index);
    for (const text of ['unknown skill "core.discovery.missing"', 'unknown tool "core.repository.missing"', 'unknown workflow-fragment "core.fragment.missing"']) {
      assert.ok(problems.some((problem) => problem.includes(text)), JSON.stringify(problems));
    }
  });
});


describe("workflow Tool policy references", () => {
  it("resolves every policy action as a required Tool reference", () => {
    for (const action of ["allow", "ask", "deny"]) {
      const document = { kind: "Workflow", id: "project.sample", tool_policies: [{ id: "safe", [action]: ["core.repository.missing"] }], phases: [] };
      const problems = resolve([{ label: "workflow", document }]);
      assert.ok(problems.some((problem) => problem.includes('unknown tool "core.repository.missing"')), `${action}: ${JSON.stringify(problems)}`);
    }
    assert.deepEqual(resolve([{ label: "workflow", document: { kind: "Workflow", id: "project.sample", tool_policies: [{ id: "safe", allow: ["core.repository.status"], ask: [], deny: [] }], phases: [] } }]), []);
  });
});
