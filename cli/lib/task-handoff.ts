import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type TaskStatus = "open" | "done";
export type TaskHandoff = { path: string; status: TaskStatus; content: string };

const headings = ["Goal", "State", "Decisions", "Mid-flow notes", "Evidence", "Next step"] as const;
const headingPattern = /^## (Goal|State|Decisions|Mid-flow notes|Evidence|Next step)\r?$/gm;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) {
    throw new Error("Invalid task slug: use lowercase letters, digits and single hyphens (maximum 100 characters)");
  }
}

function validateContent(content: string): void {
  if (typeof content !== "string" || !content.trim() || content.includes("\0")) {
    throw new Error("Task content must be nonempty text without NUL characters");
  }
  if (Buffer.from(content, "utf8").toString("utf8") !== content) {
    throw new Error("Task content contains an unpaired Unicode surrogate");
  }
  if (/^## (Goal|State|Decisions|Mid-flow notes|Evidence|Next step)\s*$/m.test(content)
    || /^Status: (open|done)\s*$/m.test(content)) {
    throw new Error("Task content cannot contain reserved section headings or status lines");
  }
}

function directory(path: string, create: boolean): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Task path contains a symbolic link: ${path}`);
    if (!stat.isDirectory()) throw new Error(`Task path is not a directory: ${path}`);
  } catch (error) {
    if (!missing(error) || !create) throw error;
    try {
      mkdirSync(path);
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
    }
    directory(path, false);
  }
}

function taskPath(projectRoot: string, slug: string, create: boolean): string {
  validateSlug(slug);
  const root = realpathSync(projectRoot);
  const paved = join(root, ".paved");
  const tasks = join(paved, "tasks");
  directory(paved, create);
  directory(tasks, create);
  return join(tasks, `${slug}.md`);
}

function readSafe(path: string): string {
  let fd: number;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Task file is a symbolic link: ${path}`);
    if (!stat.isFile()) throw new Error(`Task path is not a regular file: ${path}`);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) throw new Error(`Task not found: ${path}`);
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Task path is not a regular file: ${path}`);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`Task file is not valid UTF-8: ${path}`);
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

function parse(path: string, content: string): TaskHandoff {
  const found = [...content.matchAll(headingPattern)];
  if (found.length !== headings.length || found.some((match, index) => match[1] !== headings[index])) {
    throw new Error(`Invalid task handoff sections: ${path}`);
  }
  const stateStart = found[1]?.index;
  const stateEnd = found[2]?.index;
  if (stateStart === undefined || stateEnd === undefined) throw new Error(`Invalid task handoff: ${path}`);
  const statuses = [...content.slice(stateStart, stateEnd).matchAll(/^Status: (open|done)\r?$/gm)];
  const status = statuses[0]?.[1];
  if (statuses.length !== 1 || (status !== "open" && status !== "done")) {
    throw new Error(`Invalid task handoff status: ${path}`);
  }
  return { path, status, content };
}

function withLock<T>(path: string, action: () => T): T {
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Task is locked: ${path}`);
    }
    throw error;
  }
  try {
    return action();
  } finally {
    rmdirSync(lock);
  }
}

function writeAtomic(path: string, content: string, original?: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    created = true;
    if (original === undefined) {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new Error(`Task already exists: ${path}`);
        }
        throw error;
      }
    } else {
      if (readSafe(path) !== original) throw new Error(`Task changed while editing: ${path}`);
      chmodSync(temporary, lstatSync(path).mode & 0o7777);
      renameSync(temporary, path);
      created = false;
    }
  } finally {
    if (created) unlinkSync(temporary);
  }
}

function insertBefore(content: string, nextHeading: string, addition: string): string {
  const index = [...content.matchAll(headingPattern)].find((match) => match[1] === nextHeading)?.index;
  if (index === undefined) throw new Error(`Invalid task handoff section: ${nextHeading}`);
  const before = content.slice(0, index);
  return `${before}${before.endsWith("\n") ? "" : "\n"}\n${addition}\n\n${content.slice(index)}`;
}

export function startTask(projectRoot: string, slug: string, content: string): TaskHandoff {
  validateContent(content);
  const path = taskPath(projectRoot, slug, true);
  return withLock(path, () => {
    const text = `## Goal\n\n${content}\n\n## State\n\nStatus: open\n\n## Decisions\n\n## Mid-flow notes\n\n## Evidence\n\n## Next step\n`;
    writeAtomic(path, text);
    return parse(path, text);
  });
}

export function resumeTask(projectRoot: string, slug: string): TaskHandoff {
  const path = taskPath(projectRoot, slug, false);
  return parse(path, readSafe(path));
}

function updateTask(projectRoot: string, slug: string, content: string, section: "note" | "evidence" | "done"): TaskHandoff {
  validateContent(content);
  const path = taskPath(projectRoot, slug, false);
  return withLock(path, () => {
    const current = parse(path, readSafe(path));
    if (current.status === "done") throw new Error(`Task is already done: ${path}`);
    let updated = insertBefore(current.content, section === "done" ? "Decisions" : section === "note" ? "Evidence" : "Next step", content);
    if (section === "done") {
      const sections = [...updated.matchAll(headingPattern)];
      const stateStart = sections[1]?.index;
      const stateEnd = sections[2]?.index;
      if (stateStart === undefined || stateEnd === undefined) throw new Error(`Invalid task handoff sections: ${path}`);
      const state = updated.slice(stateStart, stateEnd).replace(/^Status: open\r?$/m, "Status: done");
      updated = updated.slice(0, stateStart) + state + updated.slice(stateEnd);
    }
    const result = parse(path, updated);
    writeAtomic(path, updated, current.content);
    return result;
  });
}

export function noteTask(projectRoot: string, slug: string, content: string): TaskHandoff {
  return updateTask(projectRoot, slug, content, "note");
}

export function doneTask(projectRoot: string, slug: string, content: string): TaskHandoff {
  return updateTask(projectRoot, slug, content, "done");
}

export function attachTaskEvidence(projectRoot: string, slug: string, content: string): TaskHandoff {
  return updateTask(projectRoot, slug, content, "evidence");
}
