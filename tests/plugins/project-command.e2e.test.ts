import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LAUNCHER_DIRECTORY, PLUGIN_DIRECTORY } from "../../plugins/build.ts";
import { ROOT } from "../helpers.ts";
import { workspace } from "./support.ts";

const temporary: string[] = [];
after(() => { for (const path of temporary) rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

const MENTION = /(^|[\s`'"(])paved (?:init|status|update|verify|intent|plan|execute|test|runtime)\b/;

function consumer(parent: string): string {
  // A space in the path proves the printed command is quoted for pasting.
  const project = join(parent, "my project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# Consumer\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  writeFileSync(join(project, "src", "feature.js"), "export const enabled = true;\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  return project;
}

describe("project-local paved command", () => {
  it("runs from a non-interactive shell outside the repository after the versioned plugin is gone", () => {
    const parent = workspace("project-command");
    temporary.push(parent);
    const plugin = join(parent, "cache", "paved", "2.0.0");
    cpSync(join(ROOT, PLUGIN_DIRECTORY), plugin, { recursive: true, verbatimSymlinks: true });
    const project = consumer(parent);
    const init = spawnSync(process.execPath, [join(plugin, LAUNCHER_DIRECTORY, "paved.mjs"), "init", "--json"], {
      cwd: project, encoding: "utf8", shell: false, env: { ...process.env, npm_config_offline: "true" },
    });
    assert.ok(init.status === 0 || init.status === 1, init.stdout + init.stderr);
    const shim = join(realpathSync(project), ".paved", "runtime", "bin", "paved");
    assert.equal(existsSync(shim), true, "the launcher writes the project command");
    assert.equal(statSync(shim).mode & 0o111, 0o111);

    // A plugin update removes the versioned directory the agent launcher lived in.
    rmSync(join(parent, "cache"), { recursive: true, force: true });
    const status = spawnSync("/bin/sh", ["-c", `'${shim}' status --json`], {
      cwd: parent, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: parent },
    });
    assert.ok(status.status === 0 || status.status === 1, status.stdout + status.stderr);
    const result = JSON.parse(status.stdout) as {
      command: string; data: { projectRoot: string; nextAction: string };
      diagnostics: { remediation?: string }[];
    };
    assert.equal(result.command, "status");
    assert.equal(result.data.projectRoot, realpathSync(project));
    for (const text of [result.data.nextAction, ...result.diagnostics.map((item) => item.remediation ?? "")]) {
      assert.doesNotMatch(text, MENTION, "every printed Paved command is runnable as is");
    }
    assert.ok(result.data.nextAction.includes(`'${shim}'`), result.data.nextAction);
    assert.match(readFileSync(join(project, ".paved", "runtime", ".gitignore"), "utf8"), /^\*$/m);
  });

  it("works on a linked worktree that shares the main worktree's state", () => {
    const parent = workspace("project-command-worktree");
    temporary.push(parent);
    const plugin = join(parent, "cache", "paved", "2.0.0");
    cpSync(join(ROOT, PLUGIN_DIRECTORY), plugin, { recursive: true, verbatimSymlinks: true });
    const project = consumer(parent);
    const git = (cwd: string, ...args: string[]) =>
      assert.equal(spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd }).status, 0);
    writeFileSync(join(project, ".gitignore"), ".paved/\n");
    git(project, "add", ".");
    git(project, "commit", "-qm", "base");
    const init = spawnSync(process.execPath, [join(plugin, LAUNCHER_DIRECTORY, "paved.mjs"), "init", "--json"], {
      cwd: project, encoding: "utf8", shell: false, env: { ...process.env, npm_config_offline: "true" },
    });
    assert.ok(init.status === 0 || init.status === 1, init.stdout + init.stderr);
    const linked = join(parent, "linked worktree");
    git(project, "worktree", "add", "-q", "-b", "feature", linked);
    const shim = join(realpathSync(project), ".paved", "runtime", "bin", "paved");
    const expectShared = (status: ReturnType<typeof spawnSync>) => {
      assert.ok(status.status === 0 || status.status === 1, `${status.stdout}${status.stderr}`);
      const result = JSON.parse(String(status.stdout)) as {
        data: { stateRoot?: string; sourceRoot?: string; nextAction: string };
        diagnostics: { code: string }[];
      };
      assert.equal(result.data.stateRoot, realpathSync(project));
      assert.equal(result.data.sourceRoot, realpathSync(linked));
      assert.ok(result.diagnostics.some((item) => item.code === "PAVED_WORKTREE_STATE_IN_MAIN"));
      // Remediation texts name the main worktree's command, which works from the linked worktree too.
      assert.ok(result.data.nextAction.includes(`'${shim}'`), result.data.nextAction);
      assert.equal(existsSync(join(linked, ".paved")), false, "the linked worktree gains no state of its own");
    };

    // The agent launcher, started in the linked worktree.
    expectShared(spawnSync(process.execPath, [join(plugin, LAUNCHER_DIRECTORY, "paved.mjs"), "status", "--json"], {
      cwd: linked, encoding: "utf8", shell: false, env: { ...process.env, npm_config_offline: "true" },
    }));
    // The stable command enters the main worktree, yet keeps working on the linked worktree it was called from.
    rmSync(join(parent, "cache"), { recursive: true, force: true });
    expectShared(spawnSync("/bin/sh", ["-c", `'${shim}' status --json`], {
      cwd: join(linked, "src"), encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: parent },
    }));
  });
});
