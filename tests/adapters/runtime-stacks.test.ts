import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { discoverAgentCommands } from "../../cli/lib/agent-commands.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { planConsumerInitialization } from "../../cli/lib/generator-runtime.ts";
import { detectCheckCandidates } from "../../cli/lib/decisions/providers/verification.ts";
import { detectTestingCandidates } from "../../cli/lib/decisions/providers/testing.ts";

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
    it(`${item.name} initializes through decisions without provider ambiguity`, async () => {
      const project = mkdtempSync(join(tmpdir(), `paved-${item.name}-`));
      try {
        writeFileSync(join(project, "README.md"), `# ${item.name}\nRepository evidence for ${item.name}.\n`);
        item.populate(project);
        const plan = planConsumerInitialization(core, project, item.name);
        assert.deepEqual(plan.resolvedAdapters, item.expected, JSON.stringify(plan));
        let init = await dispatchCli({ argv: ["init", "--project", project, "--json"], cwd: project, executablePath: join(core, "cli/index.ts") });
        let answered = false;
        for (let round = 0; round < 5 && init.status === "awaiting_input"; round += 1) {
          const answers = (init.decisions ?? []).filter((decision) => decision.required)
            .flatMap((decision) => ["--answer", `${decision.id}=${decision.recommended ?? decision.options[0]!.id}`]);
          assert.ok(answers.length > 0);
          assert.ok((init.decisions ?? []).filter((decision) => decision.required).every((decision) => decision.answerChannel === "relayed"));
          answered = true;
          init = await dispatchCli({ argv: ["init", "--project", project, ...answers, "--answered-by", "tester@example.com", "--json"], cwd: project, executablePath: join(core, "cli/index.ts") });
        }
        assert.notEqual(init.status, "failed", JSON.stringify(init));
        assert.notEqual(init.status, "awaiting_input", JSON.stringify(init));
        if (item.name === "git-only") {
          assert.equal(detectCheckCandidates(project).length, 0);
          assert.equal((init.decisions ?? []).some((decision) => /verification|checks/i.test(decision.question)), false);
        }
        assert.ok(answered || (init.decisions ?? []).length === 0);
        const status = await dispatchCli({ argv: ["status", "--project", project, "--json"], cwd: project, executablePath: join(core, "cli/index.ts") });
        const providers = (status.data as { capabilityProviders: { status: string }[] }).capabilityProviders;
        assert.equal(providers.some((provider) => provider.status === "ambiguous"), false);
        const discovery = discoverAgentCommands(project, core);
        assert.ok(["GENERATED", "VALIDATED", "READY"].includes(discovery.lifecycleState), discovery.lifecycleState);
        // init asks for the governed test command whenever the repository declares one.
        const testable = detectTestingCandidates(project).length > 0;
        assert.equal(discovery.commands.find((command) => command.name === "test")?.available, testable);
        assert.equal(discovery.commands.find((command) => command.name === "feature")?.available, testable);
      } finally { rmSync(project, { recursive: true, force: true }); }
    });
  }
});
