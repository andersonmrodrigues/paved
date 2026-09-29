import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { runDecisionGate } from "../../cli/lib/decisions/gate.ts";
import { verificationHandler } from "../../cli/lib/decisions/handlers/verification.ts";
import { rulesHandler } from "../../cli/lib/decisions/handlers/rules.ts";
import { createRegistry } from "../../cli/lib/schemas.ts";
import { listDecisions, writeDecision } from "../../cli/lib/decisions/store.ts";
import { transition } from "../../cli/lib/decisions/record.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { detectCheckCandidates, verificationProvider } from "../../cli/lib/decisions/providers/verification.ts";
import { rulesProvider } from "../../cli/lib/decisions/providers/rules.ts";
import { detectTestingCandidates, testingAdoptProvider, testingOptionId } from "../../cli/lib/decisions/providers/testing.ts";
import { testingAdoptHandler } from "../../cli/lib/decisions/handlers/testing.ts";
import { ensureAgentsBlock } from "../../cli/lib/agents-block.ts";
import { resolveTestingTool, runTestingTool } from "../../cli/lib/test-runner.ts";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";

const coreRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspaces: string[] = [];
after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paved-provider-"));
  workspaces.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const context = (projectRoot: string) => ({
  projectRoot, coreRoot, command: "verify", answers: [] as readonly string[],
});

describe("rule convention provider", () => {
  it("offers detected conventions as observed evidence", () => {
    const project = workspace({ "checkstyle.xml": '<module name="Checker"></module>' });
    const [candidate] = rulesProvider({ ...context(project), command: "init" });
    assert.ok(candidate);
    assert.equal(candidate.required, true);
    assert.equal(candidate.effect, "config-additive");
    assert.ok(candidate.evidence.some((item) => item.location === "checkstyle.xml"));
    assert.match(candidate.reason, /observed/i);
    assert.doesNotMatch(candidate.reason, /required by|must/i);
  });

  it("does not re-offer a convention whose project rule exists", () => {
    const project = workspace({
      "checkstyle.xml": '<module name="Checker"></module>',
      ".paved/rules/quality/checkstyle.yaml": "apiVersion: paved/v1\nkind: Rule\n",
    });
    assert.deepEqual(rulesProvider({ ...context(project), command: "init" }), []);
  });

  it("writes a schema-valid rule on adoption and preserves it on retry", () => {
    const project = workspace({ "checkstyle.xml": '<module name="Checker"></module>' });
    const ctx = { ...context(project), command: "init" };
    assert.deepEqual(rulesHandler.apply("adopt", ctx), [".paved/rules/quality/checkstyle.yaml"]);
    const path = join(project, ".paved/rules/quality/checkstyle.yaml");
    const first = readFileSync(path, "utf8");
    const registry = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]);
    assert.equal(registry.validate(parse(first)).valid, true);
    assert.match(first, /checkstyle\.xml/);
    assert.deepEqual(rulesHandler.apply("adopt", ctx), [".paved/rules/quality/checkstyle.yaml"]);
    assert.equal(readFileSync(path, "utf8"), first);
  });

  it("declines without writing a rule", () => {
    const project = workspace({ "checkstyle.xml": '<module name="Checker"></module>' });
    assert.deepEqual(rulesHandler.apply("decline", { ...context(project), command: "init" }), []);
    assert.equal(existsSync(join(project, ".paved/rules")), false);
  });

  it("bundles multiple conventions so one answer adopts every cited rule", () => {
    const project = workspace({
      "checkstyle.xml": '<module name="Checker"></module>',
      "eslint.config.js": "export default {};\n",
    });
    const ctx = { ...context(project), command: "init" };
    const [candidate] = rulesProvider(ctx);
    assert.equal(candidate?.evidence.length, 2);
    assert.deepEqual(rulesHandler.apply("adopt", ctx), [
      ".paved/rules/quality/checkstyle.yaml", ".paved/rules/quality/eslint.yaml",
    ]);
    assert.deepEqual(rulesProvider(ctx), []);
  });

  const BOUND_POM = "<project><artifactId>maven-checkstyle-plugin</artifactId><phase>validate</phase>"
    + "<goal>check</goal><configLocation>checkstyle.xml</configLocation><failOnViolation>true</failOnViolation></project>";
  const multiModule = () => workspace({
    "manager/backend/pom.xml": BOUND_POM,
    "manager/backend/checkstyle.xml": '<module name="Checker"/>',
    "manager/backend/checkstyle-suppressions.xml": "<suppressions/>",
    "user/backend/pom.xml": BOUND_POM,
    "user/backend/checkstyle.xml": '<module name="Checker"/>',
  });

  it("asks about each build-enforced Checkstyle module and never cites a suppressions file", () => {
    const project = multiModule();
    const [candidate] = rulesProvider({ ...context(project), command: "init" });
    assert.ok(candidate);
    assert.deepEqual(candidate.candidates, ["checkstyle-module:manager/backend", "checkstyle-module:user/backend"]);
    assert.deepEqual(candidate.options.map((option) => option.id),
      ["adopt", "module-manager-backend", "module-user-backend", "decline"]);
    assert.ok(candidate.evidence.every((item) => !item.location.includes("suppressions")));
  });

  it("adopts the precise per-module rules the generator would otherwise propose", () => {
    const project = multiModule();
    const ctx = { ...context(project), command: "init" };
    assert.deepEqual(rulesHandler.apply("adopt", ctx), [
      ".paved/rules/style/manager-backend.yaml", ".paved/rules/style/user-backend.yaml",
    ]);
    const rule = parse(readFileSync(join(project, ".paved/rules/style/manager-backend.yaml"), "utf8")) as {
      applies_to: { paths: string[] }; references: string[];
    };
    assert.deepEqual(rule.applies_to.paths, ["manager/backend/src/main/java/**"]);
    assert.deepEqual(rule.references, ["manager/backend/pom.xml", "manager/backend/checkstyle.xml"]);
    assert.equal(existsSync(join(project, ".paved/rules/quality/checkstyle.yaml")), false);
    assert.deepEqual(rulesProvider(ctx), []);
  });

  it("adopts a single module when the answer names it", () => {
    const project = multiModule();
    const ctx = { ...context(project), command: "init" };
    assert.deepEqual(rulesHandler.apply("module-user-backend", ctx), [".paved/rules/style/user-backend.yaml"]);
    assert.equal(existsSync(join(project, ".paved/rules/style/manager-backend.yaml")), false);
    assert.throws(() => rulesHandler.apply("module-missing", ctx), /Unknown rule option/);
  });

  it("does not treat a lone suppressions file as a Checkstyle convention", () => {
    const project = workspace({ "checkstyle-suppressions.xml": "<suppressions/>" });
    assert.deepEqual(rulesProvider({ ...context(project), command: "init" }), []);
  });
});

describe("verification candidate detection", () => {
  it("detects Maven lifecycle checks from a pom.xml", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const ids = detectCheckCandidates(project).map((item) => item.id);
    assert.ok(ids.includes("mvn-validate"));
    assert.ok(ids.includes("mvn-test"));
  });

  it("detects npm scripts that are actually declared", () => {
    const project = workspace({
      "package.json": JSON.stringify({ scripts: { build: "ng build", test: "ng test" } }),
      "src/app.spec.ts": "describe('app', () => {});\n",
    });
    const ids = detectCheckCandidates(project).map((item) => item.id);
    assert.ok(ids.includes("npm-build"));
    assert.ok(ids.includes("npm-test"));
  });

  it("skips ng test when the project has no spec file to run", () => {
    const project = workspace({
      "package.json": JSON.stringify({ scripts: { build: "ng build", test: "ng test" } }),
      "src/app.ts": "export class App {}\n",
    });
    const ids = detectCheckCandidates(project).map((item) => item.id);
    assert.deepEqual(ids, ["npm-build"]);
  });

  it("runs Angular Karma tests once in headless Chrome instead of watching", () => {
    const project = workspace({
      "web/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
      "web/angular.json": JSON.stringify({ projects: { web: { architect: { test: { builder: "@angular-devkit/build-angular:karma" } } } } }),
      "web/src/app.spec.ts": "describe('app', () => {});\n",
      "api/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
      "api/src/app.spec.ts": "describe('app', () => {});\n",
      "node/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    });
    const byScope = new Map(detectCheckCandidates(project).map((item) => [item.scope, item.scriptArgs]));
    assert.deepEqual(byScope.get("web"), ["--watch=false", "--browsers=ChromeHeadless"]);
    assert.deepEqual(byScope.get("api"), ["--watch=false"]);
    assert.equal(byScope.get("node"), undefined);
  });

  it("does not invent an npm script that is not declared", () => {
    const project = workspace({ "package.json": JSON.stringify({ scripts: { build: "ng build" } }) });
    assert.equal(detectCheckCandidates(project).some((item) => item.id === "npm-test"), false);
  });

  it("ignores similarly named files and empty npm scripts", () => {
    const project = workspace({
      "custom-package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "package.json": JSON.stringify({ scripts: { build: "  " } }),
      "other-pom.xml": "<project/>",
    });
    assert.deepEqual(detectCheckCandidates(project), []);
  });

  it("scopes candidates to the directory that declared them", () => {
    const project = workspace({
      "backend/pom.xml": "<project><artifactId>api</artifactId></project>",
      "frontend/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
      "frontend/src/app.spec.ts": "describe('app', () => {});\n",
    });
    const candidates = detectCheckCandidates(project);
    assert.equal(candidates.find((item) => item.id === "mvn-test")?.scope, "backend");
    assert.equal(candidates.find((item) => item.id === "npm-test")?.scope, "frontend");
  });
});

describe("verification provider", () => {
  it("offers bundled options plus none", () => {
    const project = workspace({
      "backend/pom.xml": "<project><artifactId>api</artifactId></project>",
      "frontend/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
    });
    const [candidate] = verificationProvider(context(project));
    assert.ok(candidate);
    const ids = candidate.options.map((option) => option.id);
    assert.ok(ids.includes("all"));
    assert.ok(ids.includes("none"));
    assert.equal(candidate.required, true);
    assert.equal(candidate.effect, "config-additive");
  });

  it("recommends adopting everything, citing evidence", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const [candidate] = verificationProvider(context(project));
    assert.equal(candidate?.recommended, "all");
    assert.ok((candidate?.evidence.length ?? 0) > 0, "a recommendation must cite evidence");
  });

  it("raises nothing when a verification profile already exists", () => {
    const project = workspace({
      "pom.xml": "<project><artifactId>api</artifactId></project>",
      ".paved/verification/profile.yaml": "apiVersion: paved/v1\nkind: VerificationProfile\n",
    });
    assert.deepEqual(verificationProvider(context(project)), []);
  });

  it("raises nothing when the repository has no detectable check", () => {
    const project = workspace({ "README.md": "# nothing to verify\n" });
    assert.deepEqual(verificationProvider(context(project)), []);
  });

  it("keeps scope option ids unique and within the schema limit", () => {
    const long = "nested-".repeat(12);
    const project = workspace({
      "a/b/package.json": JSON.stringify({ scripts: { test: "node --version" } }),
      "a-b/package.json": JSON.stringify({ scripts: { test: "node --version" } }),
      [`${long}/package.json`]: JSON.stringify({ scripts: { test: "node --version" } }),
    });
    const ids = verificationProvider(context(project))[0]!.options.map((option) => option.id)
      .filter((id) => id.startsWith("scope-"));
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every((id) => id.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)));
  });
});


describe("verification apply handler", () => {
  function adopt(project: string, answer: string) {
    const handlers = new Map([["verification.adopt", verificationHandler]]);
    const providers = [verificationProvider];
    const first = runDecisionGate({ context: context(project), providers, handlers, persist: true });
    const id = first.projections[0]!.id;
    return runDecisionGate({
      context: { ...context(project), answers: [`${id}=${answer}`], answeredBy: "anderson@example.com" },
      providers, handlers, persist: true,
    });
  }

  it("writes a verification profile Paved can read back", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "all");
    assert.equal(outcome.status, "continue");
    const profile = parse(readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8")) as {
      kind: string; checks: string[];
    };
    assert.equal(profile.kind, "VerificationProfile");
    assert.ok(profile.checks.length > 0);
    assert.match(profile.checks[0] ?? "", /^project\.detected\./);
    const registry = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]);
    for (const path of outcome.applied[0]?.applied_changes ?? []) {
      const document = parse(readFileSync(join(project, path), "utf8"));
      assert.equal(registry.validate(document).valid, true, path);
    }
  });

  it("records the written path as the decision's applied change", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "all");
    assert.equal(outcome.applied[0]?.applied_changes?.length, 7);
    assert.ok(outcome.applied[0]?.applied_changes?.includes(".paved/verification/profile.yaml"));
  });

  it("is idempotent — applying twice produces the same file", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    adopt(project, "all");
    const first = readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8");
    verificationHandler.apply("all", context(project));
    assert.equal(readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8"), first);
  });

  it("writes no profile when the answer is none, and records the rejection", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "none");
    assert.equal(existsSync(join(project, ".paved/verification/profile.yaml")), false);
    assert.equal(outcome.applied.length, 0);
    assert.equal(listDecisions(project, coreRoot)[0]?.status, "REJECTED");
  });

  it("never marks verification as passed — it only writes the profile", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const outcome = adopt(project, "all");
    assert.ok(outcome.applied.length > 0);
    assert.equal(existsSync(join(project, ".paved/generated/evidence")), false,
      "adopting checks must not produce verification evidence");
  });

  it("finishes an ANSWERED record after a crash following the profile write", () => {
    const project = workspace({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const handlers = new Map([["verification.adopt", verificationHandler]]);
    runDecisionGate({ context: context(project), providers: [verificationProvider], handlers, persist: true });
    const asked = listDecisions(project, coreRoot)[0]!;
    const answered = transition(asked, "ANSWERED", {
      answer: "all", answered_by: "anderson@example.com", answer_source: "agent-relayed",
      answered_at: "2026-09-28T00:05:00.000Z",
    });
    writeDecision(project, coreRoot, answered);
    verificationHandler.apply("all", context(project));
    const recovered = runDecisionGate({
      context: context(project), providers: [verificationProvider], handlers, persist: true,
    });
    assert.equal(recovered.applied[0]?.status, "APPLIED");
    assert.equal(listDecisions(project, coreRoot)[0]?.status, "APPLIED");
  });
});

describe("conversational verify", () => {
  it("asks for detected checks, then runs the adopted check", async () => {
    const project = workspace({
      "package.json": JSON.stringify({ name: "check-pilot", version: "1.0.0", scripts: { test: "node --version" } }),
    });
    const first = await dispatchCli({ argv: ["verify", "--project", project] });
    assert.equal(first.status, "awaiting_input");
    const id = first.decisions?.[0]?.id;
    assert.ok(id);
    const second = await dispatchCli({
      argv: ["verify", "--project", project, "--answer", `${id}=all`, "--answered-by", "anderson@example.com"],
    });
    assert.ok(existsSync(join(project, ".paved/verification/profile.yaml")));
    assert.equal(second.status, "success", JSON.stringify(second));
    assert.equal((second.data as { checks?: { status: string }[] } | undefined)?.checks?.[0]?.status, "passed");
  });
});

describe("testing command adoption", () => {
  const initialized = (files: Record<string, string>) => {
    const project = workspace(files);
    initializeConsumer(coreRoot, project, "example");
    return project;
  };

  it("asks which detected test command workflows run and makes testing resolvable", () => {
    const project = initialized({
      "api/pom.xml": "<project><artifactId>api</artifactId></project>",
      "web/package.json": JSON.stringify({ scripts: { test: "ng test" } }),
      "web/angular.json": JSON.stringify({ projects: { web: { architect: { test: { builder: "@angular-devkit/build-angular:karma" } } } } }),
      "web/src/app.spec.ts": "describe('app', () => {});\n",
    });
    const ctx = { ...context(project), command: "init" };
    assert.equal(resolveTestingTool(project, coreRoot).status, "unavailable");
    const [candidate] = testingAdoptProvider(ctx);
    assert.ok(candidate);
    assert.equal(candidate.handler, "testing.adopt");
    const web = detectTestingCandidates(project).find((item) => item.scope === "web")!;
    assert.deepEqual(candidate.options.map((option) => option.id).at(-1), "none");
    assert.deepEqual(testingAdoptHandler.apply(testingOptionId(web), ctx), [
      ".paved/tool-implementations/testing.yaml", ".paved/tools/testing.yaml",
    ]);
    const binding = parse(readFileSync(join(project, ".paved/tool-implementations/testing.yaml"), "utf8")) as {
      invocation: { executable: string; arguments: string[]; working_directory: string };
    };
    assert.equal(binding.invocation.executable, "npm");
    assert.equal(binding.invocation.working_directory, "web");
    assert.deepEqual(binding.invocation.arguments.slice(0, 3), ["run", "test", "--"]);
    assert.ok(binding.invocation.arguments.includes("--watch=false"));
    assert.equal(resolveTestingTool(project, coreRoot).status, "resolved");
    assert.deepEqual(testingAdoptProvider(ctx), []);
  });

  it("offers all detected module tests and records a separate binding for each", () => {
    const project = initialized({
      "lib/pom.xml": "<project><artifactId>lib</artifactId></project>",
      "api/pom.xml": "<project><artifactId>api</artifactId></project>",
      "admin/pom.xml": "<project><artifactId>admin</artifactId></project>",
    });
    const ctx = { ...context(project), command: "init" };
    const [decision] = testingAdoptProvider(ctx);
    assert.ok(decision);
    assert.equal(decision.recommended, "all");
    assert.deepEqual(decision.options.map((option) => option.label).filter((label) => label.includes("mvn test")), [
      "mvn test in admin", "mvn test in api", "mvn test in lib",
    ]);
    const paths = testingAdoptHandler.apply("all", ctx);
    assert.equal(paths.length, 6);
    const bindings = paths.filter((path) => path.startsWith(".paved/tool-implementations/"))
      .map((path) => parse(readFileSync(join(project, path), "utf8")) as { invocation: { working_directory: string } });
    assert.deepEqual(bindings.map((binding) => binding.invocation.working_directory), ["admin", "api", "lib"]);
    assert.deepEqual(testingAdoptProvider(ctx), []);
  });

  it("runs every adopted module test and reports a failure from any module", async () => {
    const project = initialized({
      "lib/package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
      "api/package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }),
      "admin/package.json": JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
    });
    const ctx = { ...context(project), command: "init" };
    testingAdoptHandler.apply("all", ctx);
    const result = await runTestingTool({ projectRoot: project, coreRoot, inputs: {} });
    assert.equal(result.status, "failed");
    assert.equal(result.tools?.length, 3);
    assert.deepEqual(result.tools?.map((tool) => tool.status), ["succeeded", "failed", "succeeded"]);
    assert.equal(result.evidences?.length, 3);
    assert.equal(result.evidence, result.evidences?.[1]);
  });

  it("does not reduce a configured module suite when one binding is missing", () => {
    const project = initialized({
      "api/pom.xml": "<project><artifactId>api</artifactId></project>",
      "admin/pom.xml": "<project><artifactId>admin</artifactId></project>",
    });
    const paths = testingAdoptHandler.apply("all", { ...context(project), command: "init" });
    rmSync(join(project, paths.find((path) => path.startsWith(".paved/tool-implementations/"))!));
    assert.equal(resolveTestingTool(project, coreRoot).status, "unavailable");
  });

  it("installs a local Maven dependency before testing its consumers", () => {
    const library = "<project><groupId>example</groupId><artifactId>shared</artifactId><version>1.0</version></project>";
    const consumer = (artifact: string) => `<project><groupId>example</groupId><artifactId>${artifact}</artifactId><version>1.0</version><dependencies><dependency><groupId>example</groupId><artifactId>shared</artifactId><version>1.0</version></dependency></dependencies></project>`;
    const project = initialized({
      "a-api/pom.xml": consumer("api"),
      "b-admin/pom.xml": consumer("admin"),
      "z-library/pom.xml": library,
    });
    const candidates = detectTestingCandidates(project);
    assert.deepEqual(candidates.map((candidate) => [candidate.scope, candidate.command]), [
      ["z-library", "install"], ["a-api", "test"], ["b-admin", "test"],
    ]);
    testingAdoptHandler.apply("all", { ...context(project), command: "init" });
    const resolution = resolveTestingTool(project, coreRoot);
    assert.equal(resolution.status, "suite");
    if (resolution.status !== "suite") return;
    assert.deepEqual(resolution.members.map((member) => [
      member.implementation.invocation.working_directory,
      member.implementation.invocation.arguments,
    ]), [
      ["z-library", ["install"]], ["a-api", ["test"]], ["b-admin", ["test"]],
    ]);
  });

  it("adopts Maven verification checks in dependency order", () => {
    const library = "<project><groupId>example</groupId><artifactId>shared</artifactId><version>1.0</version></project>";
    const api = "<project><groupId>example</groupId><artifactId>api</artifactId><version>1.0</version><dependencies><dependency><groupId>example</groupId><artifactId>shared</artifactId><version>1.0</version></dependency></dependencies></project>";
    const project = initialized({ "a-api/pom.xml": api, "z-library/pom.xml": library });
    const candidates = detectCheckCandidates(project).filter((candidate) => candidate.id === "mvn-test");
    assert.deepEqual(candidates.map((candidate) => [candidate.scope, candidate.command]), [
      ["z-library", "install"], ["a-api", "test"],
    ]);
    verificationHandler.apply("all", { ...context(project), command: "init" });
    const profile = parse(readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8")) as { checks: string[] };
    const checks = profile.checks.map((id) => {
      const candidate = detectCheckCandidates(project).find((item) => id.includes(item.scope.replace(/[^a-z0-9]+/g, "-")) && id.includes(item.id));
      return candidate?.scope;
    });
    assert.ok(checks.indexOf("z-library") < checks.indexOf("a-api"));
  });

  it("writes nothing when the user declines", () => {
    const project = initialized({ "pom.xml": "<project><artifactId>api</artifactId></project>" });
    const ctx = { ...context(project), command: "init" };
    assert.deepEqual(testingAdoptHandler.apply("none", ctx), []);
    assert.equal(testingAdoptHandler.reject?.("none"), true);
    assert.equal(existsSync(join(project, ".paved/tools/testing.yaml")), false);
  });
});

describe("AGENTS.md block", () => {
  it("appends the managed block once and preserves the user's text", () => {
    const project = workspace({ "AGENTS.md": "# Team notes\n\nKeep PRs small.\n" });
    assert.deepEqual(ensureAgentsBlock(coreRoot, project), { status: "updated" });
    const first = readFileSync(join(project, "AGENTS.md"), "utf8");
    assert.ok(first.startsWith("# Team notes\n\nKeep PRs small.\n\n<!-- paved:begin managed -->"));
    assert.deepEqual(ensureAgentsBlock(coreRoot, project), { status: "unchanged" });
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), first);
  });

  it("replaces only an outdated block and creates the file when missing", () => {
    const project = workspace({
      "AGENTS.md": "Intro\n<!-- paved:begin managed -->\nold\n<!-- paved:end managed -->\nOutro\n",
    });
    assert.deepEqual(ensureAgentsBlock(coreRoot, project), { status: "updated" });
    const text = readFileSync(join(project, "AGENTS.md"), "utf8");
    assert.ok(text.startsWith("Intro\n<!-- paved:begin managed -->\n## Paved"));
    assert.ok(text.endsWith("<!-- paved:end managed -->\nOutro\n"));
    const created = workspace({});
    assert.deepEqual(ensureAgentsBlock(coreRoot, created), { status: "created" });
    assert.match(readFileSync(join(created, "AGENTS.md"), "utf8"), /^<!-- paved:begin managed -->/);
  });

  it("leaves a file with an unterminated block untouched", () => {
    const project = workspace({ "AGENTS.md": "<!-- paved:begin managed -->\nbroken\n" });
    assert.equal(ensureAgentsBlock(coreRoot, project).status, "invalid");
    assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), "<!-- paved:begin managed -->\nbroken\n");
  });
});
