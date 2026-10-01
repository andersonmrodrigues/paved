import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { ROOT, filesRecursive, rel } from "../helpers.ts";

const LINK = /\]\(([^)\s]+)\)/g;

describe("markdown links", () => {
  it("resolve to existing files", () => {
    const broken: string[] = [];
    // The plugin's bundled runtime is the npm package as packed; its docs links point at
    // files the package does not ship.
    const markdown = filesRecursive(ROOT, (f) => f.endsWith(".md")).filter((f) => !rel(f).startsWith("plugins/paved/runtime/"));
    for (const file of markdown) {
      for (const match of readFileSync(file, "utf8").matchAll(LINK)) {
        const target = match[1]!;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const path = target.split("#")[0]!;
        if (!existsSync(resolve(dirname(file), path))) {
          broken.push(`${rel(file)} -> ${target}`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });
});
