import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { ROOT, filesRecursive, rel } from "../helpers.ts";

const LINK = /\]\(([^)\s]+)\)/g;

describe("markdown links", () => {
  it("resolve to existing files", () => {
    const broken: string[] = [];
    for (const file of filesRecursive(ROOT, (f) => f.endsWith(".md"))) {
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
