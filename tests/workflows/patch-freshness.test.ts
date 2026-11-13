import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { headPatch, patchFreshness } from "../../cli/lib/workflow-evidence.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

afterEach(cleanupTemporaryDirectories);

const ID = "9b2f6c1e0a7d4b3c8e5f1a2d6c9b0e4f7a3d8c21";

describe("patchFreshness", () => {
  it("keeps evidence fresh only for the identical patch", () => {
    assert.deepEqual(patchFreshness(ID, ID), { fresh: true });
    assert.deepEqual(patchFreshness(ID, ID.replace(/1$/, "2")), { fresh: false, reason: "patch-changed" });
  });

  it("never treats a missing fingerprint as fresh", () => {
    assert.deepEqual(patchFreshness(undefined, ID), { fresh: false, reason: "unrecorded" });
    assert.deepEqual(patchFreshness(ID, undefined), { fresh: false, reason: "empty-head" });
    assert.deepEqual(patchFreshness(undefined, undefined), { fresh: false, reason: "unrecorded" });
  });
});

describe("headPatch", () => {
  function repository(): { root: string; run: (...args: string[]) => string; write: (path: string, content: string) => void } {
    const root = temporaryDirectory("paved-patch");
    const run = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    run("init", "-q", "-b", "main");
    write("app.txt", "one\ntwo\nthree\n");
    write("other.txt", "alpha\n");
    run("add", ".");
    run("commit", "-qm", "base");
    return { root, run, write };
  }

  it("gives a rebased patch the same fingerprint and a changed patch a new one", () => {
    const { root, run, write } = repository();
    run("checkout", "-q", "-b", "change");
    write("app.txt", "one\nTWO\nthree\n");
    write(".paved/generated/runs/run.yaml", "state that is not part of the change\n");
    run("add", ".");
    run("commit", "-qm", "change");
    const before = headPatch(root, "main");
    assert.ok(!("problem" in before));
    assert.match(before.patchId ?? "", /^[0-9a-f]{40}$/);
    assert.equal(before.uncommitted, false);

    run("checkout", "-q", "main");
    write("other.txt", "alpha\nbeta\n");
    run("commit", "-qam", "upstream");
    run("checkout", "-q", "change");
    run("rebase", "-q", "main");
    const rebased = headPatch(root, "main");
    assert.ok(!("problem" in rebased));
    assert.notEqual(rebased.base, before.base);
    assert.deepEqual(patchFreshness(before.patchId, rebased.patchId), { fresh: true });

    write("app.txt", "one\nTWO\nTHREE\n");
    run("commit", "-qam", "tweak");
    const changed = headPatch(root, "main");
    assert.ok(!("problem" in changed));
    assert.deepEqual(patchFreshness(before.patchId, changed.patchId), { fresh: false, reason: "patch-changed" });

    write("app.txt", "uncommitted\n");
    assert.equal((headPatch(root, "main") as { uncommitted: boolean }).uncommitted, true);
  });

  it("refuses targets that are not revisions or look like options", () => {
    const { root } = repository();
    assert.match((headPatch(root, "missing") as { problem: string }).problem, /not a revision/);
    assert.match((headPatch(root, "--output=x") as { problem: string }).problem, /not a revision/);
    assert.equal((headPatch(root, "main") as { patchId?: string }).patchId, undefined, "no change against the target has no fingerprint");
  });
});
