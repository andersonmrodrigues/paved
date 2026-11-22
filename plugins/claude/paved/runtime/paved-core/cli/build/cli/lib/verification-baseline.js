import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Deciding whether a failing check already failed on the base revision, and running a
// check there without touching the working tree under verification.
// See docs/concepts/verification-failure.md#pre-existing-failures.
const FAILURE_WORD = /\b(?:fail|fails|failed|failure|failures|failing|panic|panicked|fatal)\b|(?:error|exception)s?\b/i;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g;
const DURATION = /\b\d+(?:[.,]\d+)?\s*(?:ms|msec|s|sec|secs|seconds?|m|min|mins|minutes?)\b/gi;
const SECTION = /^(stdout|stderr):$/;
export const ROOT_PLACEHOLDER = "<root>";
function outputLines(output) {
    return output.replace(ANSI, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !SECTION.test(line));
}
function normalize(line, roots) {
    let text = line;
    for (const root of [...roots].sort((a, b) => b.length - a.length))
        text = text.split(root).join(ROOT_PLACEHOLDER);
    return text.replace(TIMESTAMP, "<time>").replace(DURATION, "<duration>").replace(/\s+/g, " ");
}
/**
 * The lines of a check's output that report a failure, normalized so that two runs of the
 * same failure compare equal: ANSI colors removed, the source root replaced by `<root>`,
 * timestamps and durations masked and whitespace collapsed. Nothing else is masked, so a
 * different count, test name or location makes a different line.
 */
export function failureLines(output, roots = []) {
    return [...new Set(outputLines(output).filter((line) => FAILURE_WORD.test(line)).map((line) => normalize(line, roots)))];
}
/** Failure lines of the head output that the base output does not contain. */
export function newFailureLines(head, base, roots = []) {
    const known = new Set(failureLines(base, roots));
    return failureLines(head, roots).filter((line) => !known.has(line));
}
/**
 * A head failure is pre-existing when the base failed with the same exit code and every
 * failure line of the head output also appears in the base output. A head output with no
 * failure line at all cannot be compared and never counts as pre-existing.
 */
export function isPreExisting(head, base, roots = []) {
    if (head.status !== "failed" || base.status !== "failed")
        return false;
    if (head.exit_code === undefined || head.exit_code !== base.exit_code)
        return false;
    if (failureLines(head.output, roots).length === 0)
        return false;
    return newFailureLines(head.output, base.output, roots).length === 0;
}
/** The first failure lines of an output, or its last lines when none reports a failure, bounded in lines and characters. */
export function failureExcerpt(output, maxLines = 8, maxChars = 800) {
    const lines = outputLines(output);
    const failing = lines.filter((line) => FAILURE_WORD.test(line));
    const chosen = failing.length > 0 ? failing : lines.slice(-maxLines);
    const excerpt = [];
    let used = 0;
    for (const raw of chosen.slice(0, maxLines)) {
        const line = raw.length > 200 ? `${raw.slice(0, 199)}…` : raw;
        if (used + line.length > maxChars)
            break;
        excerpt.push(line);
        used += line.length;
    }
    return excerpt;
}
function git(cwd, args, timeout = 120_000) {
    return spawnSync("git", args, { cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, shell: false, env: { ...process.env, LC_ALL: "C" } });
}
/**
 * Runs `action` in a temporary detached worktree of `revision`, at the same location
 * relative to the repository root as `sourceRoot`. The worktree is removed afterwards,
 * whatever `action` does; undefined when it cannot be created. Git hooks do not run.
 */
export async function withBaseWorktree(sourceRoot, revision, action) {
    const prefix = git(sourceRoot, ["rev-parse", "--show-prefix"]);
    if (prefix.error || prefix.status !== 0)
        return undefined;
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "paved-base-")));
    const tree = join(parent, "tree");
    const hooks = join(parent, "hooks");
    mkdirSync(hooks);
    const cleanup = () => {
        git(sourceRoot, ["worktree", "remove", "--force", tree], 60_000);
        rmSync(parent, { recursive: true, force: true });
        git(sourceRoot, ["worktree", "prune"], 60_000);
    };
    // A check interrupted by a signal exits the process; the worktree still goes.
    process.once("exit", cleanup);
    try {
        const added = git(sourceRoot, ["-c", `core.hooksPath=${hooks}`, "worktree", "add", "--detach", "--quiet", tree, revision]);
        if (added.error || added.status !== 0)
            return undefined;
        return await action(join(tree, prefix.stdout.trim()));
    }
    finally {
        process.removeListener("exit", cleanup);
        cleanup();
    }
}
