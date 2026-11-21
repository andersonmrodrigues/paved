import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { doneTask, noteTask, resumeTask, startTask } from "../../cli/lib/task-handoff.ts";

const sandboxes: string[] = [];

function project(): string {
  const root = join(import.meta.dirname, `.task-handoff-${randomUUID()}`);
  mkdirSync(root);
  sandboxes.push(root);
  return root;
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task handoff", () => {
  it("starts a task with the fixed handoff sections and resumes it", () => {
    const root = project();
    const result = startTask(root, "safe-task", "Build the feature");
    assert.equal(result.path, join(root, ".paved/tasks/safe-task.md"));
    assert.equal(result.status, "open");
    assert.match(result.content, /## Goal\n\nBuild the feature/);
    assert.deepEqual([...result.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [
      "Goal", "State", "Decisions", "Mid-flow notes", "Evidence", "Next step",
    ]);
    assert.deepEqual(resumeTask(root, "safe-task"), result);
  });

  it("appends notes and completes without discarding existing sections", () => {
    const root = project();
    const { path } = startTask(root, "task", "Goal");
    const initial = readFileSync(path, "utf8").replace("## Decisions\n\n", "## Decisions\n\nKeep this decision.\n\n");
    writeFileSync(path, initial);
    noteTask(root, "task", "First note");
    noteTask(root, "task", "Second note");
    const result = doneTask(root, "task", "Completed and verified");
    assert.equal(result.status, "done");
    assert.match(result.content, /Keep this decision\./);
    assert.match(result.content, /First note[\s\S]*Second note/);
    assert.match(result.content, /Completed and verified/);
    assert.deepEqual(resumeTask(root, "task"), result);
    assert.throws(() => noteTask(root, "task", "lost"), /done|completed/i);
    assert.throws(() => doneTask(root, "task", "lost"), /done|completed/i);
    assert.equal(readFileSync(path, "utf8"), result.content);
  });

  it("rejects unsafe slugs and never overwrites an existing task", () => {
    const root = project();
    for (const slug of ["", ".", "..", "../outside", "a/b", "a\\b", "-bad", "Bad", "a\nb"]) {
      assert.throws(() => startTask(root, slug, "Goal"), /slug/i);
    }
    const first = startTask(root, "task", "Original");
    assert.throws(() => startTask(root, "task", "Replacement"), /exist/i);
    assert.equal(readFileSync(first.path, "utf8"), first.content);
  });

  it("refuses symlinked task files and state directories", () => {
    const root = project();
    const other = project();
    const outside = join(other, "outside.md");
    writeFileSync(outside, "do not touch");
    mkdirSync(join(root, ".paved/tasks"), { recursive: true });
    symlinkSync(outside, join(root, ".paved/tasks/link.md"));
    for (const action of [
      () => resumeTask(root, "link"),
      () => noteTask(root, "link", "note"),
      () => doneTask(root, "link", "done"),
      () => startTask(root, "link", "goal"),
    ]) assert.throws(action, /symbolic link|symlink|exist/i);
    assert.equal(readFileSync(outside, "utf8"), "do not touch");

    const root2 = project();
    symlinkSync(other, join(root2, ".paved"));
    assert.throws(() => startTask(root2, "task", "goal"), /symbolic link|symlink/i);
  });

  it("refuses malformed handoffs and reserved headings without changing data", () => {
    const root = project();
    const { path } = startTask(root, "task", "Goal");
    const malformed = readFileSync(path, "utf8").replace("## Evidence", "## Wrong");
    writeFileSync(path, malformed);
    assert.throws(() => noteTask(root, "task", "note"), /handoff|section/i);
    assert.throws(() => doneTask(root, "task", "done"), /handoff|section/i);
    assert.equal(readFileSync(path, "utf8"), malformed);
    assert.throws(() => startTask(root, "other", "x\n## State\ny"), /section|heading/i);
    assert.throws(() => resumeTask(root, "missing"), /not found|no such/i);
  });

  it("uses actual headings when section names occur in ordinary text and preserves file permissions", () => {
    const root = project();
    const { path } = startTask(root, "task", "See ## State and ## Evidence inline.");
    chmodSync(path, 0o640);
    noteTask(root, "task", "A note");
    const result = doneTask(root, "task", "Finished");
    assert.match(result.content, /^## Goal\n\nSee ## State and ## Evidence inline\./);
    assert.match(result.content, /## Mid-flow notes\n[\s\S]*A note[\s\S]*## Evidence/);
    assert.equal(statSync(path).mode & 0o777, 0o640);
  });

  it("refuses invalid UTF-8 rather than rewriting undecodable bytes", () => {
    const root = project();
    const { path } = startTask(root, "task", "Goal");
    const bytes = Buffer.concat([readFileSync(path), Buffer.from([0xff])]);
    writeFileSync(path, bytes);
    assert.throws(() => noteTask(root, "task", "note"), /utf-8|encoding/i);
    assert.deepEqual(readFileSync(path), bytes);
  });

  it("rejects unpaired surrogates rather than silently changing input", () => {
    const root = project();
    assert.throws(() => startTask(root, "task", "bad \ud800 text"), /unicode|surrogate/i);
    const { path, content } = startTask(root, "task", "valid");
    assert.throws(() => noteTask(root, "task", "bad \udc00 text"), /unicode|surrogate/i);
    assert.equal(readFileSync(path, "utf8"), content);
  });

  it("refuses edits while another task operation holds its lock", () => {
    const root = project();
    const { path, content } = startTask(root, "task", "Goal");
    mkdirSync(`${path}.lock`);
    assert.throws(() => noteTask(root, "task", "note"), /locked/i);
    assert.throws(() => doneTask(root, "task", "done"), /locked/i);
    assert.equal(readFileSync(path, "utf8"), content);
  });
});
