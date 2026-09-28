import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("runtime package artifact", () => {
  it("contains the runtime entrypoint and contracts without development tests", () => {
    const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(packed.error, undefined, packed.stderr);
    assert.equal(packed.status, 0, packed.stderr);
    const [artifact] = JSON.parse(packed.stdout) as {
      integrity: string;
      filename: string;
      files: { path: string }[];
    }[];
    assert.ok(artifact);
    assert.match(artifact.filename, /^paved-core-\d+\.\d+\.\d+\.tgz$/);
    assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    const paths = new Set(artifact.files.map((file) => file.path));
    for (const path of [
      "package.json",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "VERSION",
      "manifest.yaml",
      "cli/index.ts",
      "cli/build/cli/index.js",
      "schemas/lock.schema.yaml",
      "core/workflows/feature/workflow.yaml",
      "generators/project-context/architecture/generator.yaml",
      "integrations/shared/commands.ts",
      "adapters/technology/java/adapter.yaml",
    ]) assert.ok(paths.has(path), `package artifact is missing ${path}`);
    const packageMetadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      bin: { paved: string };
      engines: { node: string };
      version: string;
    };
    assert.equal(packageMetadata.bin.paved, "./cli/build/cli/index.js");
    assert.equal(packageMetadata.engines.node, ">=22.18.0");
    const cli = spawnSync(process.execPath, ["./cli/build/cli/index.js", "--version", "--json"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(cli.error, undefined, cli.stderr);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).data.version, packageMetadata.version);
    assert.equal([...paths].some((path) => path.startsWith("tests/")), false);
    assert.equal([...paths].some((path) => path.startsWith("docs/")), false);
    assert.equal(paths.has("AGENTS.md"), false);
    assert.equal(paths.has("package-lock.json"), false);
  });
});
