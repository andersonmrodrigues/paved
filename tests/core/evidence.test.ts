import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { assessEvidence, loadEvidenceRegistry, type VerificationPolicy } from "../../cli/lib/evidence.ts";
import { at, filesRecursive, formatErrors, rel, schemas } from "../helpers.ts";

type Record = Parameters<typeof assessEvidence>[0];

// A fixture states the verification policy it is assessed under in a header comment.
function policyOf(file: string): VerificationPolicy {
  const minimum = /^# minimum-recorder: (\S+)$/m.exec(readFileSync(file, "utf8"))?.[1];
  return minimum === undefined ? {} : { minimum_recorder: minimum };
}

describe("evidence semantics", () => {
  const registry = loadEvidenceRegistry(at("core", "verification", "registry.yaml"));

  it("accepts the evidence template", () => {
    const record = loadYaml(at("core", "templates", "evidence.yaml")) as Record;
    assert.deepEqual(assessEvidence(record, registry), []);
  });

  const fixtures = at("tests", "fixtures", "evidence");

  it("accepts sound records", () => {
    for (const file of filesRecursive(join(fixtures, "sound"), (f) => f.endsWith(".yaml"))) {
      const record = loadYaml(file);
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      assert.deepEqual(assessEvidence(record as Record, registry, policyOf(file)), [], rel(file));
    }
  });

  it("rejects unsound records that are structurally valid", () => {
    const files = filesRecursive(join(fixtures, "unsound"), (f) => f.endsWith(".yaml"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const record = loadYaml(file);
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      const reason = /^# expect-error: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1];
      assert.ok(reason, `${rel(file)} must state the expected rejection reason`);
      assert.ok(assessEvidence(record as Record, registry, policyOf(file)).some((problem) => problem.includes(reason)),
        `${rel(file)} should be rejected for: ${reason}`);
    }
  });
});
