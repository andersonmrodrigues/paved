import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { outOfScope, type TestingToolResolution } from "../../cli/lib/test-runner.ts";

type Resolved = Extract<TestingToolResolution, { status: "resolved" }>;

function member(name: string, workingDirectory?: string, appliesTo?: string[]): Resolved {
  return {
    status: "resolved",
    tool: { id: `project.testing-detected-${name}.run`, timeout_seconds: 900 },
    implementation: {
      id: `project.testing-binding-${name}.run`,
      invocation: { type: "command", executable: "mvn", ...(workingDirectory === undefined ? {} : { working_directory: workingDirectory }) },
      ...(appliesTo === undefined ? {} : { applies_to: appliesTo }),
    },
  } as unknown as Resolved;
}

function suite(members: Resolved[], dependencies?: Record<string, string[]>): TestingToolResolution {
  return {
    status: "suite", members,
    ...(dependencies === undefined ? {} : { dependencies: new Map(Object.entries(dependencies).map(([scope, used]) => [scope, new Set(used)])) }),
  };
}

const ids = (skipped: ReadonlyMap<string, string>): string[] => [...skipped.keys()].sort();

describe("scoping testing Tools to a change", () => {
  it("skips modules whose working directory holds no changed file, with the reason", () => {
    const selected = suite([member("api", "backend/api"), member("billing", "backend/billing"), member("web", "./frontend/web/")]);
    const skipped = outOfScope(selected, ["backend/api/src/main/java/App.java"]);
    assert.deepEqual(ids(skipped), ["project.testing-detected-billing.run", "project.testing-detected-web.run"]);
    assert.equal(skipped.get("project.testing-detected-web.run"), "No changed file is under frontend/web.");
  });

  it("does not treat a sibling directory with a common prefix as the module", () => {
    const skipped = outOfScope(suite([member("api", "backend/api"), member("apix", "backend/apix")]), ["backend/apix/pom.xml"]);
    assert.deepEqual(ids(skipped), ["project.testing-detected-api.run"]);
  });

  it("runs everything without changed files, and always runs a Tool at the repository root", () => {
    const selected = suite([member("root"), member("web", "frontend")]);
    assert.equal(outOfScope(selected, undefined).size, 0);
    assert.equal(outOfScope(selected, []).size, 0);
    assert.deepEqual(ids(outOfScope(selected, ["README.md"])), ["project.testing-detected-web.run"]);
  });

  it("uses applies_to instead of the working directory when the binding declares it", () => {
    const selected = suite([member("web", "frontend", ["frontend/**", "shared/api/**"]), member("api", "backend")]);
    assert.deepEqual(ids(outOfScope(selected, ["shared/api/schema.json"])), ["project.testing-detected-api.run"]);
    const skipped = outOfScope(selected, ["backend/pom.xml"]);
    assert.equal(skipped.get("project.testing-detected-web.run"), "No changed file matches applies_to (frontend/**, shared/api/**).");
  });

  it("runs the dependents of a changed module and the modules a running one must install", () => {
    // app consumes core, core consumes model; other is unrelated.
    const selected = suite([member("model", "model"), member("core", "core"), member("app", "app"), member("other", "other")],
      { model: [], core: ["model"], app: ["core"], other: [] });
    assert.deepEqual(ids(outOfScope(selected, ["core/src/Main.java"])), ["project.testing-detected-other.run"]);
    assert.deepEqual(ids(outOfScope(selected, ["app/src/App.java"])), ["project.testing-detected-other.run"]);
    assert.deepEqual(ids(outOfScope(selected, ["other/x"])), [
      "project.testing-detected-app.run", "project.testing-detected-core.run", "project.testing-detected-model.run",
    ]);
  });

  it("scopes a single testing Tool the same way", () => {
    const single = member("web", "frontend");
    assert.deepEqual(ids(outOfScope(single, ["backend/pom.xml"])), ["project.testing-detected-web.run"]);
    assert.equal(outOfScope(single, ["frontend/src/app.ts"]).size, 0);
  });
});
