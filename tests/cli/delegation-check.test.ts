import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

it("validates a bounded subagent result without a workflow run", async () => {
  const project = temporaryDirectory("paved-delegation-check");
  mkdirSync(join(project, ".paved"), { recursive: true });
  writeFileSync(join(project, ".paved/result.yaml"), stringify({
    apiVersion: "paved/v1", kind: "DelegationResult", findings: ["An issue."],
    files_read: ["src/index.ts"], boundaries: ["Read-only"], non_obvious: [], questions: [],
  }));
  const run = () => dispatchCli({
    argv: ["delegation", "check", "--file", ".paved/result.yaml", "--project", project],
    cwd: ROOT, executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal((await run()).status, "success");
  writeFileSync(join(project, ".paved/result.yaml"), stringify({
    apiVersion: "paved/v1", kind: "DelegationResult", findings: ["An issue."],
  }));
  assert.equal((await run()).status, "failed");
});
