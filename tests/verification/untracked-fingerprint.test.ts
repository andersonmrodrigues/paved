import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runVerification } from "../../cli/lib/verification-runner.ts";
import { attachTaskEvidence, startTask } from "../../cli/lib/task-handoff.ts";
import { loadYaml } from "../../cli/lib/documents.ts";
import { runTestingTool } from "../../cli/lib/test-runner.ts";
import type { ToolContract, ToolImplementation } from "../../cli/lib/tools.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixture = join(root, "tests/cli/fixtures/verification");
let sandbox = "";

function projectFixture(): string {
  sandbox = mkdtempSync(join(tmpdir(), "paved-untracked-fingerprint-"));
  const project = join(sandbox, "project");
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, project]);
  cpSync(fixture, project, { recursive: true });
  writeFileSync(join(project, ".git/info/exclude"), "/.paved/\n");
  chmodSync(join(project, ".paved/tools/marker.mjs"), 0o755);
  return project;
}

it("binds verification evidence to the contents of an untracked file", async () => {
  try {
    const project = projectFixture();
    const file = join(project, "untracked.txt");
    writeFileSync(file, "first");
    const first = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
    writeFileSync(file, "other");
    const second = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(second.status, "success", JSON.stringify(second.diagnostics));
    assert.ok(first.evidence?.change.worktree_sha256);
    assert.notEqual(first.evidence.change.worktree_sha256, second.evidence?.change.worktree_sha256);
    assert.equal(first.evidence.checks[0]?.execution.worktree_sha256, first.evidence.change.worktree_sha256);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("does not claim verification of a worktree changed during the check", async () => {
  try {
    const project = projectFixture();
    const marker = join(project, ".paved/tools/marker.mjs");
    const script = readFileSync(marker, "utf8");
    writeFileSync(marker, script.replace('const args = process.argv.slice(2);',
      'writeFileSync(join(process.cwd(), "untracked.txt"), "changed");\nconst args = process.argv.slice(2);'));
    writeFileSync(join(project, "untracked.txt"), "initial");
    const result = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(result.status, "failed");
    assert.equal(result.evidenceFiles.length, 0);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fingerprints untracked symlinks without following them", async () => {
  try {
    const project = projectFixture();
    const file = join(project, "link");
    symlinkSync("first-target", file);
    const first = await runVerification({ projectRoot: project, coreRoot: root });
    unlinkSync(file);
    symlinkSync("other-target", file);
    const second = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
    assert.equal(second.status, "success", JSON.stringify(second.diagnostics));
    assert.notEqual(first.evidence?.change.worktree_sha256, second.evidence?.change.worktree_sha256);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fails closed if Git lists an untracked nested repository", async () => {
  try {
    const project = projectFixture();
    const nested = join(project, "nested");
    mkdirSync(nested);
    execFileSync("git", ["init", "--quiet", nested]);
    writeFileSync(join(nested, "file"), "not captured by the outer repository");
    const result = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(result.status, "failed");
    assert.equal(result.evidenceFiles.length, 0);
    assert.ok(result.diagnostics.some((item) => item.code === "PAVED_VERIFY_CHANGE_UNPROVEN"));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("ignores task handoff state while retaining configuration in the fingerprint", async () => {
  try {
    const project = projectFixture();
    writeFileSync(join(project, ".git/info/exclude"), "");
    startTask(project, "work", "Change a file");
    const first = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
    attachTaskEvidence(project, "work", "Verification completed");
    const second = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(second.status, "success", JSON.stringify(second.diagnostics));
    assert.equal(first.evidence?.change.worktree_sha256, second.evidence?.change.worktree_sha256);
    writeFileSync(join(project, ".paved/verification/profile.yaml"),
      `${readFileSync(join(project, ".paved/verification/profile.yaml"), "utf8")}\n# changed\n`);
    const third = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(third.status, "success", JSON.stringify(third.diagnostics));
    assert.notEqual(second.evidence?.change.worktree_sha256, third.evidence?.change.worktree_sha256);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("uses the same content-sensitive fingerprint for testing and verification", async () => {
  try {
    const project = projectFixture();
    const file = join(project, "untracked.txt");
    writeFileSync(file, "first");
    const tool = loadYaml(join(root, "core/tools/testing/run.yaml")) as ToolContract;
    const implementation = {
      apiVersion: "paved/v1", kind: "ToolImplementation", id: "project.test", tool: tool.id,
      version: "1.0.0", contract: "^0.1.0", source: "project", environments: ["local"],
      invocation: { type: "command", executable: "node", arguments: ["-e", "process.stdout.write('ok')"] },
      availability: "available",
    } as ToolImplementation;
    const test = () => runTestingTool({ projectRoot: project, coreRoot: root, inputs: {} },
      { status: "resolved", tool, implementation });
    const first = await test();
    assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
    const firstRecord = loadYaml(join(project, first.evidence!)) as { change: { worktree_sha256?: string } };
    const verification = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(firstRecord.change.worktree_sha256, verification.evidence?.change.worktree_sha256);
    writeFileSync(file, "other");
    const second = await test();
    assert.equal(second.status, "success", JSON.stringify(second.diagnostics));
    const secondRecord = loadYaml(join(project, second.evidence!)) as { change: { worktree_sha256?: string } };
    assert.notEqual(firstRecord.change.worktree_sha256, secondRecord.change.worktree_sha256);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fingerprints unversioned repositories and distinguishes identical worktrees", async () => {
  sandbox = mkdtempSync(join(tmpdir(), "paved-untracked-fingerprint-"));
  try {
    const projects = ["first", "second"].map((name) => {
      const project = join(sandbox, name);
      mkdirSync(project);
      execFileSync("git", ["init", "--quiet", project]);
      cpSync(fixture, project, { recursive: true });
      chmodSync(join(project, ".paved/tools/marker.mjs"), 0o755);
      writeFileSync(join(project, "untracked.txt"), "first");
      return project;
    });

    const first = await runVerification({ projectRoot: projects[0]!, coreRoot: root });
    const second = await runVerification({ projectRoot: projects[1]!, coreRoot: root });
    assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
    assert.equal(second.status, "success", JSON.stringify(second.diagnostics));
    assert.ok(first.evidence?.change.worktree_sha256);
    assert.notEqual(first.evidence.change.worktree_sha256, second.evidence?.change.worktree_sha256);
    writeFileSync(join(projects[0]!, "untracked.txt"), "other");
    const changed = await runVerification({ projectRoot: projects[0]!, coreRoot: root });
    assert.equal(changed.status, "success", JSON.stringify(changed.diagnostics));
    assert.notEqual(first.evidence.change.worktree_sha256, changed.evidence?.change.worktree_sha256);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

it("fingerprints content outside Git instead of assigning all trees unversioned", async () => {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  sandbox = mkdtempSync(join(tmpdir(), "paved-untracked-fingerprint-"));
  process.env.GIT_CEILING_DIRECTORIES = sandbox;
  try {
    const project = join(sandbox, "project");
    cpSync(fixture, project, { recursive: true });
    chmodSync(join(project, ".paved/tools/marker.mjs"), 0o755);
    writeFileSync(join(project, "untracked.txt"), "first");
    const first = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(first.status, "success", JSON.stringify(first.diagnostics));
    assert.ok(first.evidence?.change.worktree_sha256);
    writeFileSync(join(project, "untracked.txt"), "other");
    const second = await runVerification({ projectRoot: project, coreRoot: root });
    assert.equal(second.status, "success", JSON.stringify(second.diagnostics));
    assert.notEqual(first.evidence.change.worktree_sha256, second.evidence?.change.worktree_sha256);
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
