import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { at, coreManifest, formatErrors, ownershipOf, schemas } from "../helpers.ts";

describe("core manifest", () => {
  const manifest = coreManifest();

  it("is a valid Core manifest", () => {
    const result = schemas().validate(loadYaml(at("manifest.yaml")));
    assert.ok(result.valid, formatErrors("manifest.yaml", result.errors));
  });

  it("has one version across VERSION, package.json and the changelog", () => {
    const version = readFileSync(at("VERSION"), "utf8").trim();
    assert.equal(manifest.version, version);
    assert.equal((JSON.parse(readFileSync(at("package.json"), "utf8")) as { version: string }).version, version);
    assert.match(readFileSync(at("CHANGELOG.md"), "utf8"), new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m"));
  });

  it("points at content roots and schemas that exist", () => {
    for (const path of [...Object.values(manifest.content), ...Object.values(manifest.schemas)]) {
      assert.ok(existsSync(at(path)), `${path} does not exist`);
    }
  });

  it("declares each consumer path once and keeps the ownership model", () => {
    const paths = manifest.consumer_layout.map((entry) => entry.path);
    assert.equal(new Set(paths).size, paths.length);
    const expected: Record<string, string> = {
      ".paved/manifest.yaml": "human-owned",
      ".paved/project/x": "generated-reviewed",
      ".paved/generated/x": "disposable",
      ".paved/overrides/x": "human-owned",
      ".paved/rules/x": "project-owned",
      ".paved/verification/x": "project-owned",
      ".paved/workflows/x": "project-owned",
      ".paved/documents/x": "project-owned",
      ".paved/paved.lock": "tool-managed",
      ".paved/runtime/x": "tool-managed",
    };
    for (const [path, ownership] of Object.entries(expected)) {
      assert.equal(ownershipOf(path, manifest.consumer_layout), ownership, path);
    }
  });

  it("requires only the project manifest, so adoption can be incremental", () => {
    const required = manifest.consumer_layout.filter((entry) => entry.required).map((entry) => entry.path);
    assert.deepEqual(required, [".paved/manifest.yaml"]);
  });

  it("keeps work documents optional and committed with the project", () => {
    const documents = manifest.consumer_layout.find((entry) => entry.path === ".paved/documents/");
    assert.ok(documents, "work document root is declared");
    assert.equal(documents.ownership, "project-owned");
    assert.equal(documents.required, false);
    assert.equal(documents.committed, true);
  });

  it("names only known document kinds as consumer path schemas", () => {
    for (const entry of manifest.consumer_layout) {
      if (entry.schema !== undefined) {
        assert.ok(entry.schema in manifest.schemas, `${entry.path}: unknown kind ${entry.schema}`);
      }
    }
  });

  // Skills declare context areas; this map is how an agent finds each one in a consumer.
  it("maps every context area a skill can declare to a consumer path", () => {
    const common = loadYaml(at("schemas", "common.schema.yaml")) as { $defs: { contextArea: { enum: string[] } } };
    assert.deepEqual(Object.keys(manifest.context_areas).sort(), [...common.$defs.contextArea.enum].sort());
    const layout = manifest.consumer_layout.map((entry) => entry.path);
    for (const [area, path] of Object.entries(manifest.context_areas)) {
      assert.ok(
        layout.some((entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`)),
        `${area}: ${path} is not in the consumer layout`,
      );
    }
  });
});
