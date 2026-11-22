import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { failureExcerpt, failureLines, isPreExisting, newFailureLines, withBaseWorktree } from "../../cli/lib/verification-baseline.ts";
import { orderChecks } from "../../cli/lib/verification-order.ts";

describe("failure line comparison", () => {
  it("normalizes colors, roots, timestamps, durations and spacing, and nothing else", () => {
    const head = "\u001b[31mFAIL\u001b[0m  /work/head/src/a.spec.ts (1.2 s)\n12:00:01 Error: boom\nok line\n";
    const base = "FAIL /work/base/src/a.spec.ts (840 ms)\n09:30:00 Error: boom\n";
    assert.deepEqual(failureLines(head, ["/work/head"]), ["FAIL <root>/src/a.spec.ts (<duration>)", "<time> Error: boom"]);
    assert.deepEqual(newFailureLines(head, base, ["/work/head", "/work/base"]), []);
    assert.deepEqual(newFailureLines("Tests: 2 failed\n", "Tests: 1 failed\n"), ["Tests: 2 failed"]);
  });

  it("calls a failure pre-existing only when the base failed alike and has every head failure line", () => {
    const failed = (output: string, exit_code = 1) => ({ status: "failed", exit_code, output });
    assert.equal(isPreExisting(failed("FAIL a\n"), failed("FAIL a\nFAIL b\n")), true);
    assert.equal(isPreExisting(failed("FAIL a\nFAIL c\n"), failed("FAIL a\n")), false);
    assert.equal(isPreExisting(failed("FAIL a\n"), failed("FAIL a\n", 2)), false);
    assert.equal(isPreExisting(failed("FAIL a\n"), { status: "passed", exit_code: 0, output: "" }), false);
    assert.equal(isPreExisting(failed("nothing recognizable\n"), failed("nothing recognizable\n")), false);
  });

  it("bounds the excerpt in lines and characters, preferring failure lines", () => {
    const output = Array.from({ length: 30 }, (_, index) => `FAIL test ${index} ${"x".repeat(150)}`).join("\n");
    const excerpt = failureExcerpt(output);
    assert.ok(excerpt.length <= 8);
    assert.ok(excerpt.join("").length <= 800);
    assert.match(excerpt[0]!, /^FAIL test 0/);
    assert.deepEqual(failureExcerpt("one\ntwo\nthree\n", 2), ["two", "three"]);
    assert.equal(failureExcerpt("y".repeat(500))[0]!.length, 200);
  });
});

describe("base worktree", () => {
  it("runs at the base revision in a temporary worktree and removes it, even when the action throws", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "paved-baseline-test-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(repo, "state.txt"), "base\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "state.txt"), "head\n");

      let seen = "";
      const content = await withBaseWorktree(repo, base, async (root) => {
        seen = root;
        return execFileSync("cat", [join(root, "state.txt")], { encoding: "utf8" });
      });
      assert.equal(content, "base\n");
      assert.equal(existsSync(seen), false);

      await assert.rejects(withBaseWorktree(repo, base, async () => { throw new Error("check crashed"); }), /check crashed/);
      assert.equal(git("worktree", "list").trim().split("\n").length, 1);
      assert.equal(await withBaseWorktree(repo, "0".repeat(40), async () => "never"), undefined);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("check order", () => {
  it("orders dependencies first and keeps profile order otherwise", () => {
    const result = orderChecks([{ id: "c", depends_on: ["b"] }, { id: "a" }, { id: "b" }]);
    assert.ok("ordered" in result);
    assert.deepEqual(result.ordered.map((check) => check.id), ["b", "c", "a"]);
  });

  it("reports a cycle and an unresolved dependency", () => {
    assert.deepEqual(orderChecks([{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["c"] }, { id: "c", depends_on: ["a"] }]),
      { cycle: ["a", "b", "c", "a"] });
    assert.deepEqual(orderChecks([{ id: "a", depends_on: ["z"] }]), { unresolved: [{ check: "a", dependency: "z" }] });
  });
});
