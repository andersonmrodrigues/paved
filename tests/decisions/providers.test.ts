import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { runDecisionGate } from "../../cli/lib/decisions/gate.ts";
import { verificationHandler } from "../../cli/lib/decisions/handlers/verification.ts";
import { createRegistry } from "../../cli/lib/schemas.ts";
import { listDecisions, writeDecision } from "../../cli/lib/decisions/store.ts";
import { transition } from "../../cli/lib/decisions/record.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { detectCheckCandidates, verificationProvider } from "../../cli/lib/decisions/providers/verification.ts";

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
    });
    const ids = detectCheckCandidates(project).map((item) => item.id);
    assert.ok(ids.includes("npm-build"));
    assert.ok(ids.includes("npm-test"));
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
