import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const core = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

function consumer(): string {
  const root = temporaryDirectory("paved-tool-add");
  writeFileSync(join(root, "README.md"), "# Consumer\n");
  initializeConsumer(core, root, "consumer");
  return root;
}

const add = (root: string, ...argv: string[]) => dispatchCli({ argv: ["tool", "add", ...argv.slice(0, argv.indexOf("--")), "--project", root, "--json", ...argv.slice(argv.indexOf("--"))] });

describe("paved tool add", () => {
  it("writes a Tool, binding and Check, adds it to the profile, and verify runs it", async () => {
    const root = consumer();
    writeFileSync(join(root, "ok.mjs"), "process.exit(0);\n");

    const added = await add(root, "unit", "node tests", "--", process.execPath, "ok.mjs", "-q");

    assert.equal(added.status, "success", JSON.stringify(added));
    const check = (added.data as { check: string }).check;
    const profile = parse(readFileSync(join(root, ".paved/verification/profile.yaml"), "utf8")) as { checks: string[] };
    assert.deepEqual(profile.checks, [check]);
    const binding = (added.data as { files: string[] }).files.find((path) => path.startsWith(".paved/tool-implementations/"))!;
    assert.deepEqual((parse(readFileSync(join(root, binding), "utf8")) as { invocation: { arguments: string[] } }).invocation.arguments, ["ok.mjs", "-q"]);
    const verified = await dispatchCli({ argv: ["verify", "--project", root, "--json"] });
    assert.equal(verified.status, "success", JSON.stringify(verified.diagnostics));
  });

  it("keeps the profile's existing checks when adding another", async () => {
    const root = consumer();
    const first = await add(root, "build", "--", "node", "--version");
    const second = await add(root, "static-analysis", "--", "node", "--check", "x.js");
    const profile = parse(readFileSync(join(root, ".paved/verification/profile.yaml"), "utf8")) as { checks: string[] };
    assert.deepEqual(profile.checks, [(first.data as { check: string }).check, (second.data as { check: string }).check]);
  });

  it("rejects an unknown check type without writing anything", async () => {
    const root = consumer();
    const added = await add(root, "vibes", "--", "node", "--version");
    assert.equal(added.diagnostics[0]?.code, "PAVED_TOOL_INVALID", JSON.stringify(added));
    assert.throws(() => readFileSync(join(root, ".paved/verification/profile.yaml")));
  });

  it("requires a command after --", async () => {
    const result = await dispatchCli({ argv: ["tool", "add", "unit", "--project", consumer(), "--json"] });
    assert.equal(result.diagnostics[0]?.code, "PAVED_TOOL_USAGE");
  });
});
