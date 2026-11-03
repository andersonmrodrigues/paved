import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectShortcutDebt } from "../cli/commands/gardener.ts";

test("collects tracked shortcut markers as a sorted read-only ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "paved-shortcut-debt-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/b.ts"), "// shortcut: handles small files; revisit when uploads exceed 10 MB\n");
    writeFileSync(join(root, "src/a.ts"), "// no marker\n// shortcut: retries once; revisit when failures recur\n");
    execFileSync("git", ["-C", root, "add", "src"]);
    assert.deepEqual(collectShortcutDebt(root), [
      { path: "src/a.ts", line: 2, limitation: "retries once", revisit_when: "failures recur" },
      { path: "src/b.ts", line: 1, limitation: "handles small files", revisit_when: "uploads exceed 10 MB" },
    ]);
    assert.equal(collectShortcutDebt(root).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires a Git repository for shortcut debt collection", () => {
  const root = mkdtempSync(join(tmpdir(), "paved-shortcut-debt-no-git-"));
  try { assert.throws(() => collectShortcutDebt(root), /requires a Git repository/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
