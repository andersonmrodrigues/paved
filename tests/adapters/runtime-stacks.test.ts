import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { discoverAgentCommands } from "../../cli/lib/agent-commands.ts";
import { initializeConsumer, planConsumerInitialization, runGenerators } from "../../cli/lib/generator-runtime.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("representative consumer runtimes", () => {
  const cases = [
    { name: "java-quarkus", expected: ["technology/java", "technology/quarkus"], populate: (root: string) => {
      cpSync(join(core, "tests/fixtures/adapters/quarkus-project"), root, { recursive: true });
    } },
    { name: "typescript-angular", expected: ["technology/angular", "technology/typescript"], populate: (root: string) => {
      cpSync(join(core, "tests/fixtures/adapters/angular-project"), root, { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    } },
    { name: "dart", expected: ["technology/dart"], populate: (root: string) => {
      writeFileSync(join(root, "pubspec.yaml"), "name: sample\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n");
    } },
    { name: "dart-flutter", expected: ["technology/dart", "technology/flutter"], populate: (root: string) => {
      writeFileSync(join(root, "pubspec.yaml"), "name: sample\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n");
    } },
    { name: "postgresql", expected: ["technology/postgresql"], populate: (root: string) => {
      writeFileSync(join(root, "application.properties"), "quarkus.datasource.db-kind=postgresql\n");
    } },
    { name: "git-only", expected: ["infrastructure/git"], populate: (root: string) => {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    } },
  ];

  for (const item of cases) {
    it(`${item.name} resolves only supported adapters and keeps testing unavailable without a binding`, () => {
      const project = mkdtempSync(join(tmpdir(), `paved-${item.name}-`));
      try {
        writeFileSync(join(project, "README.md"), `# ${item.name}\nRepository evidence for ${item.name}.\n`);
        item.populate(project);
        const plan = planConsumerInitialization(core, project, item.name);
        assert.deepEqual(plan.resolvedAdapters, item.expected, JSON.stringify(plan));
        initializeConsumer(core, project, item.name);
        const generated = runGenerators(core, project);
        assert.deepEqual(generated.errors, []);
        const discovery = discoverAgentCommands(project, core);
        assert.ok(["GENERATED", "VALIDATED", "READY"].includes(discovery.lifecycleState), discovery.lifecycleState);
        assert.equal(discovery.commands.find((command) => command.name === "test")?.available, false);
        assert.equal(discovery.commands.find((command) => command.name === "feature")?.available, false);
      } finally { rmSync(project, { recursive: true, force: true }); }
    });
  }
});
