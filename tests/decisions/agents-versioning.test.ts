import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { agentsVersioningHandler, addLocalExclude } from "../../cli/lib/decisions/handlers/agents.ts";
import { AGENTS_VERSIONING_QUESTION, agentsVersioningProvider, inspectAgentsVersioning } from "../../cli/lib/decisions/providers/agents.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import type { DecisionProjection } from "../../cli/result.ts";

const coreRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspaces: string[] = [];
after(() => { for (const path of workspaces) rmSync(path, { recursive: true, force: true }); });

// The machine's own git configuration (a global excludes file, for one) must not decide these tests.
const isolatedConfig = mkdtempSync(join(tmpdir(), "paved-agents-gitconfig-"));
workspaces.push(isolatedConfig);
writeFileSync(join(isolatedConfig, "config"), "");
process.env.GIT_CONFIG_GLOBAL = join(isolatedConfig, "config");
process.env.GIT_CONFIG_NOSYSTEM = "1";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Paved Test", "-c", "user.email=paved@example.invalid", ...args], { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paved-agents-versioning-")));
  workspaces.push(root);
  writeFileSync(join(root, "README.md"), "# Consumer\n");
  return root;
}

function repository(): string {
  const root = directory();
  git(root, "init", "-q");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "baseline");
  return root;
}

const context = (projectRoot: string) => ({ projectRoot, coreRoot, command: "init", answers: [] as readonly string[] });
const exclude = (root: string) => readFileSync(join(root, ".git/info/exclude"), "utf8");

async function init(projectRoot: string, ...extra: string[]) {
  return dispatchCli({ argv: ["init", "--project", projectRoot, "--no-generate", "--json", ...extra] });
}

function versioningDecision(decisions: readonly DecisionProjection[] | undefined): DecisionProjection | undefined {
  return decisions?.find((decision) => decision.question === AGENTS_VERSIONING_QUESTION);
}

describe("AGENTS.md versioning decision", () => {
  it("is not asked outside a git working tree", () => {
    const project = directory();
    assert.equal(inspectAgentsVersioning(project), undefined);
    assert.deepEqual(agentsVersioningProvider(context(project)), []);
  });

  it("is never asked about a tracked AGENTS.md", () => {
    const project = repository();
    writeFileSync(join(project, "AGENTS.md"), "# Team rules\n");
    git(project, "add", "AGENTS.md");
    assert.equal(inspectAgentsVersioning(project)?.state, "tracked");
    assert.deepEqual(agentsVersioningProvider(context(project)), []);
  });

  it("is not asked when the file is already ignored", () => {
    const project = repository();
    writeFileSync(join(project, ".git/info/exclude"), "/AGENTS.md\n");
    assert.equal(inspectAgentsVersioning(project)?.state, "ignored");
    assert.deepEqual(agentsVersioningProvider(context(project)), []);
  });

  it("asks about an untracked or missing AGENTS.md with track and keep-local options", () => {
    const project = repository();
    const [candidate] = agentsVersioningProvider(context(project));
    assert.ok(candidate);
    assert.equal(candidate.required, true);
    assert.equal(candidate.effect, "config-additive");
    assert.deepEqual(candidate.options.map((option) => option.id), ["track", "keep-local"]);
    assert.equal(candidate.recommended, undefined);
    // Writing the managed block must not change the fingerprint and re-ask.
    writeFileSync(join(project, "AGENTS.md"), "# Local notes\n");
    assert.deepEqual(agentsVersioningProvider(context(project))[0]?.candidates, candidate.candidates);
  });

  it("defers the AGENTS.md write during init until the project answers, then keeps it local", async () => {
    const project = repository();
    const asked = await init(project);
    const decision = versioningDecision(asked.decisions);
    assert.ok(decision, JSON.stringify(asked.decisions));
    assert.equal(asked.status, "awaiting_input");
    assert.equal((asked.data as { agentsBlock?: string }).agentsBlock, "deferred");
    assert.equal(existsSync(join(project, "AGENTS.md")), false);

    const answered = await init(project, "--answer", `${decision.id}=keep-local`, "--answered-by", "user@example.com");
    assert.equal(versioningDecision(answered.decisions), undefined);
    assert.equal((answered.data as { agentsBlock?: string }).agentsBlock, "created");
    assert.match(readFileSync(join(project, "AGENTS.md"), "utf8"), /paved:begin managed/);
    assert.equal(exclude(project).split("\n").filter((line) => line === "/AGENTS.md").length, 1);
    assert.equal(git(project, "status", "--porcelain", "--untracked-files=all", "--", "AGENTS.md"), "");
    assert.equal(git(project, "ls-files", "--", ".gitignore"), "", "a tracked .gitignore is never written");
  });

  it("writes AGENTS.md as before and excludes nothing when the answer is track", async () => {
    const project = repository();
    const decision = versioningDecision((await init(project)).decisions);
    assert.ok(decision);
    const before = existsSync(join(project, ".git/info/exclude")) ? exclude(project) : "";
    const answered = await init(project, "--answer", `${decision.id}=track`, "--answered-by", "user@example.com");
    assert.equal((answered.data as { agentsBlock?: string }).agentsBlock, "created");
    assert.equal(existsSync(join(project, ".git/info/exclude")) ? exclude(project) : "", before);
    assert.match(git(project, "status", "--porcelain", "--", "AGENTS.md"), /\?\? AGENTS\.md/);
  });

  it("writes AGENTS.md without asking outside git", async () => {
    const project = directory();
    const result = await init(project);
    assert.equal(versioningDecision(result.decisions), undefined);
    assert.equal((result.data as { agentsBlock?: string }).agentsBlock, "created");
  });

  it("adds the exclude pattern once and keeps existing lines", () => {
    const project = repository();
    writeFileSync(join(project, ".git/info/exclude"), "# local\n*.log");
    assert.equal(addLocalExclude(project, "/AGENTS.md"), true);
    assert.equal(addLocalExclude(project, "/AGENTS.md"), false);
    assert.equal(exclude(project), "# local\n*.log\n/AGENTS.md\n");
    assert.deepEqual(agentsVersioningHandler.apply("keep-local", context(project)), []);
  });

  it("anchors the pattern to a project in a subdirectory of the repository", () => {
    const repo = repository();
    const project = join(repo, "app");
    mkdirSync(project);
    assert.equal(inspectAgentsVersioning(project)?.repositoryPath, "app/AGENTS.md");
    assert.deepEqual(agentsVersioningHandler.apply("keep-local", context(project)), [".git/info/exclude"]);
    assert.match(exclude(repo), /^\/app\/AGENTS\.md$/m);
    assert.equal(inspectAgentsVersioning(project)?.state, "ignored");
  });

  it("writes the exclude shared by every worktree of the clone", () => {
    const main = repository();
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), "paved-agents-linked-"))), "linked");
    workspaces.push(join(linked, ".."));
    git(main, "worktree", "add", "-q", linked);
    assert.deepEqual(agentsVersioningHandler.apply("keep-local", context(linked)), [".git/info/exclude"]);
    const common = resolve(linked, git(linked, "rev-parse", "--git-common-dir").trim());
    assert.match(readFileSync(join(common, "info/exclude"), "utf8"), /^\/AGENTS\.md$/m);
    assert.equal(inspectAgentsVersioning(main)?.state, "ignored");
    assert.equal(inspectAgentsVersioning(linked)?.state, "ignored");
  });

  it("rejects an option it does not offer", () => {
    assert.throws(() => agentsVersioningHandler.apply("commit", context(repository())), /Unknown AGENTS.md versioning option/);
  });
});
