import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { dispatchCli } from "../../cli/runtime.ts";

const FORBIDDEN = [
  ".paved/manifest.yaml",
  ".paved/paved.lock",
  ".paved/verification/profile.yaml",
  /^\.paved\/tools\//,
  /^\.paved\/rules\//,
];

const workspaces: string[] = [];
after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

/** Every harness write is checked so user-owned Paved configuration cannot be supplied as input. */
function userWrite(project: string, path: string, content: string): void {
  const normalized = relative(project, join(project, path)).split("\\").join("/");
  for (const rule of FORBIDDEN) {
    const hit = typeof rule === "string" ? normalized === rule : rule.test(normalized);
    if (hit) throw new Error(`Clean-room violation: the user must never edit ${normalized}`);
  }
  mkdirSync(join(project, path, ".."), { recursive: true });
  writeFileSync(join(project, path), content);
}

function cleanRepository(files: Record<string, string>): string {
  const project = mkdtempSync(join(tmpdir(), "paved-cleanroom-"));
  workspaces.push(project);
  for (const [path, content] of Object.entries(files)) userWrite(project, path, content);
  return project;
}

async function answerEverything(project: string, command: string, args: readonly string[]) {
  let result = await dispatchCli({ argv: [command, ...args, "--project", project, "--json"] });
  for (let round = 0; round < 10 && result.status === "awaiting_input"; round += 1) {
    const answers = (result.decisions ?? [])
      .filter((decision) => decision.required && decision.answerChannel === "relayed")
      .flatMap((decision) => ["--answer", `${decision.id}=${decision.recommended ?? decision.options[0]!.id}`]);
    if (answers.length === 0) break;
    result = await dispatchCli({
      argv: [command, ...args, ...answers, "--answered-by", "anderson@example.com", "--project", project, "--json"],
    });
  }
  return result;
}

const APECATUS_SHAPED = {
  "backend/pom.xml": "<project><artifactId>apecatus-api</artifactId></project>",
  "backend/src/main/java/App.java": "class App {}\n",
  "backend/checkstyle.xml": '<module name="Checker"></module>',
  "frontend/package.json": JSON.stringify({ name: "ui", scripts: { build: "ng build", test: "ng test" } }),
  "frontend/src/app/app.component.ts": "export class AppComponent {}\n",
  "README.md": "# Apecatus-shaped fixture\n",
};

describe("no manual configuration is ever required", () => {
  it("completes init through a conversation alone", async () => {
    const project = cleanRepository(APECATUS_SHAPED);
    const result = await answerEverything(project, "init", []);
    assert.notEqual(result.status, "failed", JSON.stringify(result));
    const status = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    const data = status.data as { lifecycleState: string; verificationReadiness: string };
    assert.ok(["GENERATED", "VALIDATED", "READY"].includes(data.lifecycleState), data.lifecycleState);
    assert.equal(data.verificationReadiness, "ready");
  });

  it("resolves both stacks without provider ambiguity", async () => {
    const project = cleanRepository(APECATUS_SHAPED);
    await answerEverything(project, "init", []);
    const status = await dispatchCli({ argv: ["status", "--project", project, "--json"] });
    const providers = (status.data as { capabilityProviders: { status: string }[] }).capabilityProviders;
    assert.equal(providers.some((entry) => entry.status === "ambiguous"), false);
  });

  it("never instructs the user to edit a Paved file", async () => {
    const project = cleanRepository(APECATUS_SHAPED);
    const result = await answerEverything(project, "init", []);
    const rendered = JSON.stringify(result);
    assert.doesNotMatch(rendered, /Copy .*template/i);
    assert.doesNotMatch(rendered, /Create \.paved\/verification\/profile\.yaml/i);
    assert.doesNotMatch(rendered, /Edit \.paved\//i);
  });

  for (const command of ["verify", "gardener", "doctor"]) {
    it(`completes ${command} without manual configuration`, async () => {
      const project = cleanRepository(APECATUS_SHAPED);
      await answerEverything(project, "init", []);
      const result = await answerEverything(project, command, []);
      assert.notEqual(result.status, "awaiting_input", `${command} still needs a relayed answer`);
    });
  }

  for (const command of ["feature", "fix", "refactor"]) {
    it(`starts ${command} without manual configuration`, async () => {
      const project = cleanRepository(APECATUS_SHAPED);
      await answerEverything(project, "init", []);
      const result = await answerEverything(project, command, ["do the thing"]);
      assert.doesNotMatch(JSON.stringify(result), /Edit \.paved\//i);
      assert.doesNotMatch(JSON.stringify(result), /Configure \.paved\/verification/i);
    });
  }

  it("proves the guard itself works", () => {
    const project = cleanRepository({ "README.md": "# x\n" });
    assert.throws(() => userWrite(project, ".paved/verification/profile.yaml", "x"), /Clean-room violation/);
    assert.throws(() => userWrite(project, ".paved/rules/quality/x.yaml", "x"), /Clean-room violation/);
  });
});
