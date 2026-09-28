import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runDecisionGate } from "../../cli/lib/decisions/gate.ts";
import { answeredProviders, capabilityHandler, capabilityProvider } from "../../cli/lib/decisions/providers/capability.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const coreRoot = fileURLToPath(new URL("../..", import.meta.url));
afterEach(cleanupTemporaryDirectories);

describe("capability decision", () => {
  it("records an ambiguous root provider and reads it back for resolution", () => {
    const projectRoot = temporaryDirectory("paved-capability-decision");
    mkdirSync(join(projectRoot, "src"));
    writeFileSync(join(projectRoot, "pom.xml"), "<project><artifactId>api</artifactId></project>");
    writeFileSync(join(projectRoot, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(projectRoot, "src/App.java"), "class App {}\n");
    const handlers = new Map([["capability.select", capabilityHandler]]);
    const context = { projectRoot, coreRoot, command: "init", answers: [] as readonly string[] };
    const first = runDecisionGate({ context, providers: [capabilityProvider], handlers, persist: true });
    const decision = first.projections.find((item) => item.question.includes("source.build"));
    assert.ok(decision);
    const second = runDecisionGate({
      context: { ...context, answers: [`${decision.id}=technology-java`], answeredBy: "anderson@example.com" },
      providers: [capabilityProvider], handlers, persist: true,
    });
    assert.ok(second.applied.some((item) => item.id === decision.id));
    assert.equal(answeredProviders(projectRoot, coreRoot).get("source.build"), "technology/java");
  });

  it("does not ask when the manifest already selects the provider", () => {
    const projectRoot = temporaryDirectory("paved-capability-explicit");
    mkdirSync(join(projectRoot, ".paved"));
    writeFileSync(join(projectRoot, "pom.xml"), "<project><artifactId>api</artifactId></project>");
    writeFileSync(join(projectRoot, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(projectRoot, ".paved/manifest.yaml"),
      "adapters:\n  - id: technology/java\n    version: ^1.0.0\n  - id: technology/typescript\n    version: ^1.0.0\ncapability_providers:\n  source.build: technology/java\n");
    const candidates = capabilityProvider({ projectRoot, coreRoot, command: "init", answers: [] });
    assert.ok(candidates.every((item) => !item.question.includes("source.build")));
  });
});
