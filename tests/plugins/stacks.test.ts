// The representative consumer stacks, initialized through the plugin launcher from an
// installed copy of the plugin rather than through the Core source checkout.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PLUGIN_DIRECTORY } from "../../plugins/build.ts";
import { ROOT } from "../helpers.ts";
import { applicationDigest, launcher, workspace, type Invocation } from "./support.ts";
import { detectTestingCandidates } from "../../cli/lib/decisions/providers/testing.ts";

interface StackDecision {
  id: string; question: string; required: boolean; answerChannel: string;
  recommended?: string; options: { id: string }[];
}

function initializeThroughDecisions(paved: (cwd: string, ...args: string[]) => Invocation, project: string): { result: Invocation; questions: StackDecision[] } {
  let result = paved(project, "init", "--json");
  const questions = [...(result.json.decisions ?? [])] as StackDecision[];
  for (let round = 0; round < 5 && result.json.status === "awaiting_input"; round += 1) {
    const decisions = (result.json.decisions ?? []) as StackDecision[];
    const answers = decisions.filter((decision) => decision.required)
      .flatMap((decision) => ["--answer", `${decision.id}=${decision.recommended ?? decision.options[0]!.id}`]);
    if (answers.length === 0) break;
    if (decisions.filter((decision) => decision.required).some((decision) => decision.answerChannel !== "relayed")) {
      throw new Error("Stack initialization offered a non-relayed decision.");
    }
    result = paved(project, "init", ...answers, "--answered-by", "tester@example.com", "--json");
  }
  return { result, questions };
}

const fixture = (name: string) => join(ROOT, "tests", "fixtures", "adapters", name);

const cases: { name: string; expected: string[]; populate: (root: string) => void }[] = [
  { name: "java-quarkus", expected: ["technology/java", "technology/quarkus"], populate: (root) => cpSync(fixture("quarkus-project"), root, { recursive: true }) },
  { name: "typescript-angular", expected: ["technology/angular", "technology/typescript"], populate: (root) => {
    cpSync(fixture("angular-project"), root, { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  } },
  { name: "dart", expected: ["technology/dart"], populate: (root) => writeFileSync(join(root, "pubspec.yaml"), "name: sample\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n") },
  { name: "dart-flutter", expected: ["technology/dart", "technology/flutter"], populate: (root) => {
    writeFileSync(join(root, "pubspec.yaml"), "name: sample\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\n");
  } },
  { name: "postgresql", expected: ["technology/postgresql"], populate: (root) => writeFileSync(join(root, "application.properties"), "quarkus.datasource.db-kind=postgresql\n") },
  { name: "git-only", expected: ["infrastructure/git"], populate: (root) => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  } },
];

describe("representative stacks through the plugin launcher", () => {
  let root = "";
  let paved: (cwd: string, ...args: string[]) => Invocation;

  before(() => {
    root = workspace("plugin-stacks");
    const plugin = join(root, "installed", "paved");
    cpSync(join(ROOT, PLUGIN_DIRECTORY), plugin, { recursive: true });
    mkdirSync(join(root, "npm-cache"));
    paved = launcher(plugin, join(root, "npm-cache"));
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  for (const item of cases) {
    it(`${item.name} resolves its adapters through the conversational initializer`, () => {
      const project = join(root, item.name);
      mkdirSync(project);
      writeFileSync(join(project, "README.md"), `# ${item.name}\nRepository evidence for ${item.name}.\n`);
      item.populate(project);
      const before = applicationDigest(project);
      const { result: initialized, questions } = initializeThroughDecisions(paved, project);
      assert.ok(initialized.status === 0 || initialized.status === 1, initialized.stdout + initialized.stderr);
      assert.notEqual(initialized.json.status, "failed", initialized.stdout);
      assert.notEqual(initialized.json.status, "awaiting_input", initialized.stdout);
      if (item.name === "git-only") {
        assert.equal(questions.some((decision) => /verification|checks/i.test(decision.question)), false);
      }
      assert.equal((initialized.json.data as { initialized: boolean }).initialized, true, initialized.stdout);
      const status = paved(project, "status", "--json").json.data as { resolvedAdapters: string[]; coreRoot: string; capabilityProviders: { status: string }[] };
      assert.deepEqual(status.resolvedAdapters, item.expected);
      assert.equal(status.capabilityProviders.some((provider) => provider.status === "ambiguous"), false);
      assert.ok(status.coreRoot.startsWith(realpathSync(join(project, ".paved", "runtime"))), status.coreRoot);
      const discovery = paved(project, "agent", "commands", "--json").json.data as { lifecycleState: string; commands: { name: string; available: boolean }[] };
      assert.ok(["GENERATED", "VALIDATED", "READY"].includes(discovery.lifecycleState), discovery.lifecycleState);
      // init asks for the governed test command whenever the repository declares one.
      const testable = detectTestingCandidates(project).length > 0;
      assert.equal(discovery.commands.find((command) => command.name === "test")?.available, testable);
      assert.equal(discovery.commands.find((command) => command.name === "feature")?.available, testable);
      assert.equal(applicationDigest(project, [".git"]), before, "initialization leaves application files untouched");
    });
  }
});
