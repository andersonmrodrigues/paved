// The representative consumer stacks, initialized through the plugin launcher from an
// installed copy of the plugin rather than through the Core source checkout.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PLUGIN_DIRECTORY } from "../../plugins/build.ts";
import { ROOT } from "../helpers.ts";
import { applicationDigest, launcher, workspace, type Invocation } from "./support.ts";

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
    it(`${item.name} resolves only its adapters and exposes no unbound testing`, () => {
      const project = join(root, item.name);
      mkdirSync(project);
      writeFileSync(join(project, "README.md"), `# ${item.name}\nRepository evidence for ${item.name}.\n`);
      item.populate(project);
      const before = applicationDigest(project);
      const initialized = paved(project, "init", "--json");
      assert.ok(initialized.status === 0 || initialized.status === 1, initialized.stdout + initialized.stderr);
      assert.equal((initialized.json.data as { initialized: boolean }).initialized, true, initialized.stdout);
      const status = paved(project, "status", "--json").json.data as { resolvedAdapters: string[]; coreRoot: string };
      assert.deepEqual(status.resolvedAdapters, item.expected);
      assert.ok(status.coreRoot.startsWith(realpathSync(join(project, ".paved", "runtime"))), status.coreRoot);
      const discovery = paved(project, "agent", "commands", "--json").json.data as { lifecycleState: string; commands: { name: string; available: boolean }[] };
      assert.ok(["GENERATED", "VALIDATED", "READY"].includes(discovery.lifecycleState), discovery.lifecycleState);
      assert.equal(discovery.commands.find((command) => command.name === "test")?.available, false);
      assert.equal(discovery.commands.find((command) => command.name === "feature")?.available, false);
      assert.equal(applicationDigest(project, [".git"]), before, "initialization leaves application files untouched");
    });
  }
});
