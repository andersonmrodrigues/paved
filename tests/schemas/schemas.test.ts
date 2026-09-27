import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { loadMarkdown, loadYaml } from "../../cli/lib/documents.ts";
import { checkApiVersion, loadSchemas, schemaIdForKind } from "../../cli/lib/schemas.ts";
import { at, coreManifest, filesRecursive, formatErrors, rel, schemas, subdirectories } from "../helpers.ts";

describe("schemas", () => {
  const files = readdirSync(at("schemas")).filter((f) => f.endsWith(".schema.yaml"));

  it("compile under Ajv strict mode", () => {
    for (const id of schemas().schemaIds()) {
      assert.doesNotThrow(() => schemas().validateAs(id, {}), `schema ${id} failed to compile`);
    }
  });

  it("declare draft 2020-12, a title and an $id matching the file name", () => {
    for (const schema of loadSchemas(at("schemas"))) {
      assert.equal(schema["$schema"], "https://json-schema.org/draft/2020-12/schema");
      assert.equal(typeof schema["title"], "string");
    }
    for (const file of files) {
      const schema = loadYaml(at("schemas", file)) as { $id: string };
      assert.equal(schema.$id, `urn:paved:schema:${basename(file, ".schema.yaml")}:v1`, file);
    }
  });

  it("are all registered in the Core manifest and mapped to the same schema as the library", () => {
    const manifest = coreManifest();
    const registered = new Set([...Object.values(manifest.schemas), ...manifest.schema_definitions]);
    for (const file of files) {
      assert.ok(registered.has(`schemas/${file}`), `schemas/${file} is not in manifest.yaml`);
    }
    for (const [kind, path] of Object.entries(manifest.schemas)) {
      const schema = loadYaml(at(path)) as { $id: string };
      assert.equal(schemaIdForKind(kind), schema.$id, `kind ${kind}`);
    }
  });

  it("keep shared definitions independent of document schemas", () => {
    // Document schemas build on shared definitions, never the other way round, so the
    // $ref graph between files stays acyclic.
    const shared = new Set(coreManifest().schema_definitions.map((path) => loadYaml(at(path)) as { $id: string }).map((s) => s.$id));
    for (const path of coreManifest().schema_definitions) {
      const text = readFileSync(at(path), "utf8");
      for (const [, id] of text.matchAll(/"(urn:paved:schema:[a-z-]+:v\d+)[#"]/g)) {
        assert.ok(shared.has(id!), `${path} references document schema ${id}`);
      }
    }
    assert.doesNotMatch(readFileSync(at("schemas", "common.schema.yaml"), "utf8"), /urn:paved:schema:provenance/);
  });

  it("keep the check type enum in sync with the verification registry", () => {
    const common = loadYaml(at("schemas", "common.schema.yaml")) as {
      $defs: { checkType: { anyOf: [{ enum: string[] }, unknown] } };
    };
    const registry = loadYaml(at("core", "verification", "registry.yaml")) as { check_types: Record<string, unknown> };
    assert.deepEqual([...common.$defs.checkType.anyOf[0].enum].sort(), Object.keys(registry.check_types).sort());
  });
});

describe("schema fixtures", () => {
  const fixtureRoot = at("tests", "fixtures", "schemas");

  // Documents are validated as a Paved tool would (apiVersion, then the schema for their
  // kind); fragments without a kind (provenance) against the schema their directory names.
  const validate = (kind: string, document: unknown) =>
    document !== null && typeof document === "object" && "kind" in document
      ? schemas().validate(document)
      : schemas().validateAs(`urn:paved:schema:${kind}:v1`, document);

  it("exist, valid and invalid, for every schema", () => {
    for (const file of readdirSync(at("schemas")).filter((f) => f.endsWith(".schema.yaml"))) {
      const kind = basename(file, ".schema.yaml");
      if (kind === "common") continue;
      for (const variant of ["valid", "invalid"]) {
        const found = filesRecursive(join(fixtureRoot, kind, variant), (f) => f.endsWith(".yaml"));
        assert.ok(found.length > 0, `no ${variant} fixtures for ${file}`);
      }
    }
  });

  for (const kind of subdirectories(fixtureRoot)) {
    it(`${kind}: valid fixtures pass`, () => {
      for (const file of filesRecursive(join(fixtureRoot, kind, "valid"), (f) => f.endsWith(".yaml"))) {
        const document = loadYaml(file) as { kind?: string };
        if (document.kind !== undefined) {
          assert.equal(schemaIdForKind(document.kind), `urn:paved:schema:${kind}:v1`, `${rel(file)} is in the wrong directory`);
        }
        const result = validate(kind, document);
        assert.ok(result.valid, formatErrors(rel(file), result.errors));
      }
    });

    it(`${kind}: invalid fixtures fail for the stated reason`, () => {
      const invalid = filesRecursive(join(fixtureRoot, kind, "invalid"), (f) => f.endsWith(".yaml"));
      assert.ok(invalid.length > 0, `${kind} has no invalid fixtures`);
      for (const file of invalid) {
        const expected = /^# expect-error: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
        assert.ok(expected, `${rel(file)} must declare "# expect-error: <text>"`);
        const result = validate(kind, loadYaml(file));
        assert.equal(result.valid, false, `${rel(file)} should be invalid`);
        assert.ok(
          result.errors.some((error) => error.includes(expected)),
          `${rel(file)}: no error contains "${expected}"\n  ${result.errors.join("\n  ")}`,
        );
      }
    });
  }
});

describe("apiVersion compatibility", () => {
  const supported = ["paved/v1"];

  it("accepts a supported version", () => {
    assert.equal(checkApiVersion("paved/v1", supported), undefined);
  });

  it("distinguishes missing, malformed, newer, older and unsupported versions", () => {
    assert.match(checkApiVersion(undefined, supported) ?? "", /has no `apiVersion`/);
    assert.match(checkApiVersion("v1", supported) ?? "", /is not a Paved API version/);
    assert.match(checkApiVersion(1, supported) ?? "", /is not a Paved API version/);
    assert.match(checkApiVersion("paved/v2", supported) ?? "", /newer than this Core supports/);
    assert.match(checkApiVersion("paved/v0", supported) ?? "", /older than this Core supports/);
    assert.match(checkApiVersion("paved/v2", ["paved/v1", "paved/v3"]) ?? "", /is not supported/);
  });

  it("is checked before the document schema", () => {
    const result = schemas().validate({ apiVersion: "paved/v2", kind: "Rule" });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /newer than this Core supports/);
  });
});

describe("templates", () => {
  it("YAML templates are valid documents", () => {
    const templates = filesRecursive(at("core", "templates"), (f) => f.endsWith(".yaml"));
    assert.ok(templates.length > 0);
    for (const file of templates) {
      const result = schemas().validate(loadYaml(file));
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
    }
  });

  it("Markdown templates with a kind have valid frontmatter", () => {
    const templates = filesRecursive(at("core", "templates"), (f) => f.endsWith(".md"))
      .map((file) => ({ file, frontmatter: loadMarkdown(file).frontmatter }))
      .filter(({ frontmatter }) => "kind" in frontmatter);
    assert.ok(templates.length > 0);
    for (const { file, frontmatter } of templates) {
      const result = schemas().validate(frontmatter);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
    }
  });
});
