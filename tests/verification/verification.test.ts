import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadYaml } from "../../cli/lib/documents.ts";
import { assessCheck, type CheckContract, type ToolSummary } from "../../cli/lib/checks.ts";
import { assessEvidence, evaluateCompletion, loadEvidenceRegistry, type EvidenceRecord } from "../../cli/lib/evidence.ts";
import { at, formatErrors, schemas } from "../helpers.ts";
import { coreChecks, coreTools } from "../core/registries.ts";

const registry = loadEvidenceRegistry(at("core", "verification", "registry.yaml"));
const original = loadYaml(at("core", "templates", "evidence.yaml")) as EvidenceRecord;
const copy = (): EvidenceRecord => structuredClone(original);

describe("verification completion", () => {
  it("keeps Core Check definitions generic and compatible with their Tools", () => {
    const tools = new Map(coreTools().map(({ document }) => {
      const summary: ToolSummary = {
        safety: document.safety as string,
        inputs: document.inputs as ToolSummary["inputs"],
      };
      if (typeof document.timeout_seconds === "number") summary.timeout_seconds = document.timeout_seconds;
      return [document.id, summary] as const;
    }));
    for (const { file, expectedId, document } of coreChecks()) {
      assert.equal(document.id, expectedId, file);
      const validity = schemas().validate(document);
      assert.ok(validity.valid, formatErrors(file, validity.errors));
      assert.deepEqual(assessCheck(document as unknown as CheckContract, tools), [], file);
    }
  });

  it("rejects high-impact Tools as Check executors", () => {
    const tools = new Map([["core.infrastructure.apply", { safety: "high-impact", inputs: [] }]]);
    const definition = {
      id: "core.synthetic.check", title: "Synthetic check", purpose: "Observe a result.",
      type: "deployment", tool: "core.infrastructure.apply", expected: { description: "Success." },
      failure: "Report failure.",
    };
    assert.match(assessCheck(definition, tools).join("\n"), /high-impact/);
  });

  it("validates synthetic Check, profile and Evidence fixtures with expected decisions", () => {
    for (const name of ["check", "profile"]) {
      const value = loadYaml(at("tests", "fixtures", "verification", `${name}.yaml`));
      const result = schemas().validate(value);
      assert.ok(result.valid, formatErrors(name, result.errors));
    }
    const cases = [
      ["success", "complete", "verified"],
      ["failed", "incomplete", "partially-verified"],
      ["blocked", "blocked", "partially-verified"],
      ["skipped", "incomplete", "partially-verified"],
      ["inconclusive", "incomplete", "partially-verified"],
      ["partial", "incomplete", "partially-verified"],
      ["flaky", "incomplete", "unverified"],
      ["performance", "complete", "verified"],
      ["runtime", "complete", "verified"],
    ] as const;
    for (const [name, status, verification] of cases) {
      const record = loadYaml(at("tests", "fixtures", "evidence", "synthetic", `${name}.yaml`)) as EvidenceRecord;
      const result = schemas().validate(record);
      assert.ok(result.valid, formatErrors(name, result.errors));
      const decision = evaluateCompletion(record, registry);
      assert.equal(decision.status, status, name);
      assert.equal(decision.verification, verification, name);
      assert.deepEqual(assessEvidence(record, registry), [], name);
    }
  });

  it("accepts a successful verification", () => {
    const record = copy();
    assert.deepEqual(assessEvidence(record, registry), []);
    assert.equal(evaluateCompletion(record, registry).status, "complete");
    assert.equal(evaluateCompletion(record, registry).verification, "verified");
  });

  it("rejects duplicate check ids in an evidence record", () => {
    const record = copy();
    record.checks.push(structuredClone(record.checks[0]!));

    assert.match(assessEvidence(record, registry).join("\n"), /duplicate id/);
  });

  it("does not complete when a required type has only an accepted gap", () => {
    const record = copy();
    record.plan.required.push("integration");
    record.gaps ??= [];
    record.gaps.push({ check_type: "integration", risk: "low" });
    const decision = evaluateCompletion(record, registry);
    assert.equal(decision.status, "incomplete");
    assert.equal(decision.verification, "partially-verified");
    assert.match(decision.blocking.join("\n"), /required integration/);
    assert.match(assessEvidence(record, registry).join("\n"), /required integration/);
  });

  for (const [checkStatus, expectedStatus] of [
    ["failed", "incomplete"],
    ["blocked", "blocked"],
    ["skipped", "incomplete"],
    ["inconclusive", "incomplete"],
  ] as const) {
    it(`records a ${checkStatus} required check without claiming completion`, () => {
      const record = copy();
      record.plan.required.push("integration");
      const check = structuredClone(record.checks[0]!);
      check.id = "integration-run";
      check.check = "project.test.integration";
      check.type = "integration";
      check.status = checkStatus;
      if (checkStatus === "blocked" || checkStatus === "skipped") {
        check.reason = "The required environment is unavailable.";
        delete (check as { exit_code?: number }).exit_code;
      }
      if (checkStatus === "failed") check.summary = "One assertion failed.";
      record.checks.push(check);
      const result = evaluateCompletion(record, registry);
      assert.equal(result.status, expectedStatus);
      assert.equal(result.verification, "partially-verified");
      assert.notEqual(result.blocking.length, 0);
    });
  }

  it("keeps a failed attempt visible when a retry passes", () => {
    const record = copy();
    const check = record.checks[0]!;
    record.plan.required = ["runtime"];
    check.type = "runtime";
    check.check = "project.app.smoke";
    check.status = "inconclusive";
    check.flaky = true;
    check.attempts = [
      { status: "failed", summary: "timeout" },
      { status: "passed", summary: "exit 0" },
    ];
    const result = evaluateCompletion(record, registry);
    assert.equal(result.status, "incomplete");
    assert.equal(result.verification, "unverified");
    assert.match(result.warnings.join("\n"), /flaky/);
  });

  it("judges a performance measurement against its baseline", () => {
    const record = loadYaml(at("tests", "fixtures", "evidence", "sound", "performance-with-measurements.yaml")) as EvidenceRecord;
    const check = structuredClone(record.checks[0]!);
    check.id = "performance-run";
    check.check = "project.test.performance";
    check.type = "performance";
    check.measurement = {
      direction: "lower-is-better", baseline: { value: 100 }, current: { value: 108 },
      threshold: { max_regression: 0.1, relative: true },
    };
    record.checks.push(check);
    record.plan.required.push("performance");
    assert.equal(evaluateCompletion(record, registry).status, "complete");
    check.measurement.current.value = 112;
    assert.match(assessEvidence(record, registry).join("\n"), /beyond the threshold/);
  });

  it("uses runtime observations as behavior support", () => {
    const record = copy();
    const check = structuredClone(record.checks[0]!);
    check.id = "runtime-run";
    check.check = "project.app.smoke";
    check.type = "runtime";
    record.checks.push(check);
    record.plan.required.push("runtime");
    record.claims[0]!.supported_by = ["runtime-run"];
    assert.equal(evaluateCompletion(record, registry).status, "complete");
    assert.equal(evaluateCompletion(record, registry).verification, "verified");
  });

  it("rejects a claimed pass when the observed exit code contradicts the Check", () => {
    const record = copy();
    record.checks[0]!.exit_code = 1;
    const definitions = new Map([["project.test.unit", {
      id: "project.test.unit", type: "unit", tool: "project.test.run-unit",
      expected: { exit_code: 0 },
    }]]);
    assert.match(assessEvidence(record, registry, {}, definitions).join("\n"), /exit code 1/);
  });

  it("bounds attempts by the referenced Check definition", () => {
    const record = copy();
    record.checks[0]!.attempts = [
      { status: "passed" }, { status: "passed" }, { status: "passed" },
    ];
    const definitions = new Map([["project.test.unit", {
      id: "project.test.unit", type: "unit", tool: "project.test.run-unit",
      retry: { class: "retryable", max_attempts: 2 },
    }]]);
    assert.match(assessEvidence(record, registry, {}, definitions).join("\n"), /allows 2/);
  });
});
