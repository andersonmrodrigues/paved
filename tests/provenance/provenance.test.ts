import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadMarkdown } from "../../cli/lib/documents.ts";
import { assessProvenance, parseManagedBlocks } from "../../cli/lib/provenance.ts";
import { at, filesRecursive, formatErrors, rel, schemas } from "../helpers.ts";

type Traced = Parameters<typeof assessProvenance>[0];

describe("provenance", () => {
  const fixtures = at("tests", "fixtures", "provenance");

  it("Markdown templates cite only declared sources and have well-formed blocks", () => {
    for (const file of filesRecursive(at("core", "templates"), (f) => f.endsWith(".md"))) {
      const { frontmatter, body } = loadMarkdown(file);
      assert.deepEqual(assessProvenance(frontmatter as Traced, body), [], rel(file));
    }
  });

  it("sound documents pass", () => {
    for (const file of filesRecursive(join(fixtures, "sound"), (f) => f.endsWith(".md"))) {
      const { frontmatter, body } = loadMarkdown(file);
      const result = schemas().validate(frontmatter);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      assert.deepEqual(assessProvenance(frontmatter as Traced, body), [], rel(file));
    }
  });

  it("unsound documents are schema-valid but fail for the stated reason", () => {
    const files = filesRecursive(join(fixtures, "unsound"), (f) => f.endsWith(".md"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const expected = /^# expect-problem: (.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
      assert.ok(expected, `${rel(file)} must declare "# expect-problem: <text>"`);
      const { frontmatter, body } = loadMarkdown(file);
      const result = schemas().validate(frontmatter);
      assert.ok(result.valid, formatErrors(rel(file), result.errors));
      const problems = assessProvenance(frontmatter as Traced, body);
      assert.ok(
        problems.some((problem) => problem.includes(expected)),
        `${rel(file)}: no problem contains "${expected}"\n  ${problems.join("\n  ")}`,
      );
    }
  });

  it("parses managed blocks and their attributes", () => {
    const { blocks, problems } = parseManagedBlocks(
      [
        "text",
        "<!-- paved:begin managed -->",
        "<!-- paved:end managed -->",
        "  <!-- paved:begin generated id=a sources=x,y confidence=inferred -->",
        "<!-- paved:end generated -->",
      ].join("\n"),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(
      blocks.map((b) => [b.type, b.line, b.attributes]),
      [
        ["managed", 2, {}],
        ["generated", 4, { id: "a", sources: "x,y", confidence: "inferred" }],
      ],
    );
  });
});
