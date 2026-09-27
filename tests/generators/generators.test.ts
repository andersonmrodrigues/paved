import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { headings, loadMarkdown, loadYaml } from "../../cli/lib/documents.ts";
import { schemaIdForKind } from "../../cli/lib/schemas.ts";
import { at, coreManifest, filesRecursive, formatErrors, layoutEntryOf, ownershipOf, rel, schemas } from "../helpers.ts";

const REQUIRED_SECTIONS = [
  "Input",
  "Output",
  "Preconditions",
  "Sources analyzed",
  "Strategy",
  "Limitations",
  "Unknown information",
  "Avoiding invention",
  "Change detection",
];

// Generators may only write where regeneration cannot destroy human-owned knowledge.
const WRITABLE_OWNERSHIP = new Set(["generated-reviewed", "disposable"]);

interface Generator {
  id: string;
  depends_on?: string[];
  outputs: { path: string; schema?: string; metadata: "inline" | "sidecar" }[];
}

describe("generators", () => {
  const root = at("generators");
  const contracts = filesRecursive(root, (f) => f.endsWith("generator.yaml")).map((file) => ({
    file,
    dir: dirname(file),
    generator: loadYaml(file) as Generator,
  }));
  const ids = new Set(contracts.map((c) => c.generator.id));
  const layout = coreManifest().consumer_layout;

  it("cover the generator categories the architecture defines", () => {
    for (const id of [
      "project-context/architecture",
      "project-context/domain",
      "project-context/product",
      "project-context/integrations",
      "project-context/feature-map",
      "verification",
      "rules",
      "skills",
      "tools",
    ]) {
      assert.ok(ids.has(id), `missing generator ${id}`);
    }
  });

  for (const { file, dir, generator } of contracts) {
    describe(generator.id, () => {
      it("generator.yaml is valid and its id matches its directory", () => {
        const result = schemas().validate(generator);
        assert.ok(result.valid, formatErrors(rel(file), result.errors));
        assert.equal(generator.id, relative(root, dir));
      });

      it("depends only on existing generators", () => {
        for (const dependency of generator.depends_on ?? []) {
          assert.ok(ids.has(dependency), `unknown dependency ${dependency}`);
        }
      });

      it("writes only to generated-reviewed or disposable paths", () => {
        for (const output of generator.outputs) {
          const ownership = ownershipOf(output.path, layout);
          assert.ok(
            ownership !== undefined && WRITABLE_OWNERSHIP.has(ownership),
            `${output.path} has ownership ${ownership ?? "undefined"}`,
          );
          if (output.schema !== undefined) {
            assert.ok(schemaIdForKind(output.schema), `unknown document kind ${output.schema}`);
          }
          const declared = layoutEntryOf(output.path, layout)?.schema;
          if (declared !== undefined) {
            assert.equal(output.schema, declared, `${output.path} must be written as ${declared}`);
          }
        }
      });

      // Inline metadata needs somewhere to live: the output's schema must have a provenance field.
      it("declares inline metadata only for outputs whose schema carries provenance", () => {
        for (const output of generator.outputs.filter((o) => o.metadata === "inline")) {
          assert.ok(output.schema !== undefined, `${output.path}: inline metadata needs a schema`);
          const file = coreManifest().schemas[output.schema];
          const schema = loadYaml(at(file!)) as { properties?: Record<string, unknown> };
          assert.ok(schema.properties?.["provenance"], `${output.path}: ${output.schema} has no provenance field`);
        }
      });

      it("GENERATOR.md documents every required aspect", () => {
        const present = headings(loadMarkdown(join(dir, "GENERATOR.md")).body, 2);
        assert.deepEqual(present, REQUIRED_SECTIONS);
      });
    });
  }

  it("have an acyclic dependency graph", () => {
    const graph = new Map(contracts.map((c) => [c.generator.id, c.generator.depends_on ?? []]));
    const state = new Map<string, "visiting" | "done">();
    const visit = (id: string, path: string[]) => {
      if (state.get(id) === "done") return;
      assert.notEqual(state.get(id), "visiting", `cycle: ${[...path, id].join(" -> ")}`);
      state.set(id, "visiting");
      for (const next of graph.get(id) ?? []) visit(next, [...path, id]);
      state.set(id, "done");
    };
    for (const id of graph.keys()) visit(id, []);
  });
});
