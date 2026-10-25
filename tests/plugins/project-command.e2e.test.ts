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
});
