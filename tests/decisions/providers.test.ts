import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
});
