import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

it("reports quick initialization status without writing project files", async () => {
  const project = temporaryDirectory("paved-doctor-quick-command");
  const result = await dispatchCli({
    argv: ["doctor", "--quick", "--project", project], cwd: ROOT, executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.ok(result.data, JSON.stringify(result));
  assert.equal((result.data as { status: string }).status, "uninitialized", JSON.stringify(result));
  assert.equal(existsSync(join(project, ".paved")), false);
});
