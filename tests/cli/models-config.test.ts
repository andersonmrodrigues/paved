import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRegistry, schemaIdForKind } from "../../cli/lib/schemas.ts";
import { ensureModelsConfig, validateModelsConfig } from "../../cli/lib/models-config.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const work = join(root, "tests/.work/models-config");
const registry = createRegistry(join(root, "schemas"), ["paved/v1"]);

afterEach(() => rmSync(work, { recursive: true, force: true }));

test("ModelPolicy is registered and validates role preferences without claiming host availability", () => {
  const valid = {
    apiVersion: "paved/v1",
    kind: "ModelPolicy",
    roles: {
      explorer: ["fast-model"],
      implementer: ["session"],
      reviewer: ["other-family-model"],
      mechanical: ["cheap-model"],
    },
  };
  assert.equal(schemaIdForKind("ModelPolicy"), "urn:paved:schema:model-policy:v1");
  assert.equal(registry.validate(valid).valid, true);
  assert.equal(registry.validate({ ...valid, roles: { implementer: [""] } }).valid, false);
});

test("models config validator accepts the pre-contract human format and does not rewrite it", () => {
  const project = join(work, "consumer");
  mkdirSync(join(project, ".paved"), { recursive: true });
  const path = join(project, ".paved/models.yaml");
  const humanConfig = "roles:\n  implementer: [human-selected-model]\n  reviewer: [session]\n";
  writeFileSync(path, humanConfig);

  assert.equal(validateModelsConfig(project, registry), undefined);
  assert.equal(ensureModelsConfig(project, registry), false);
  assert.equal(readFileSync(path, "utf8"), humanConfig);
});

test("models config validator rejects invalid human configuration without replacing it", () => {
  const project = join(work, "invalid-consumer");
  mkdirSync(join(project, ".paved"), { recursive: true });
  const path = join(project, ".paved/models.yaml");
  const invalid = "apiVersion: paved/v1\nkind: ModelPolicy\nroles:\n  implementer: []\n";
  writeFileSync(path, invalid);

  assert.match(validateModelsConfig(project, registry) ?? "", /models\.yaml is invalid/);
  assert.throws(() => ensureModelsConfig(project, registry), /models\.yaml is invalid/);
  assert.equal(readFileSync(path, "utf8"), invalid);
});

test("models config validator rejects symlinks before following or replacing them", () => {
  const project = join(work, "symlink-consumer");
  const external = join(work, "human-model-preferences.yaml");
  mkdirSync(join(project, ".paved"), { recursive: true });
  writeFileSync(external, "roles:\n  implementer: [private-model]\n");
  symlinkSync(external, join(project, ".paved/models.yaml"));

  assert.match(validateModelsConfig(project, registry) ?? "", /symbolic link/);
  assert.throws(() => ensureModelsConfig(project, registry), /symbolic link/);
  assert.equal(readFileSync(external, "utf8"), "roles:\n  implementer: [private-model]\n");
});
