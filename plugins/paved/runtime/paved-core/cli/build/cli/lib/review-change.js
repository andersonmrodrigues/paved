import { spawnSync } from "node:child_process";
import { mergeBase, resolveCommit } from "./workflow-evidence.js";
const PATHSPEC = ["--", ".", ":(exclude).paved", ":(exclude).paved.update-backup", ":(exclude).paved-operation-lock"];
function git(root, args, allowDiff = false) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.error || (result.status !== 0 && !(allowDiff && result.status === 1))) {
        throw new Error("Cannot determine the review change from Git.");
    }
    return result.stdout;
}
function counts(entry) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(entry);
    if (!match)
        throw new Error("Git returned an invalid review change.");
    const added = match[1] === "-" ? null : Number(match[1]);
    const deleted = match[2] === "-" ? null : Number(match[2]);
    return { added, deleted, path: match[3] };
}
function numstat(root, args) {
    return git(root, args).split("\0").filter(Boolean).map((entry) => {
        const result = counts(entry);
        return { path: result.path, added: result.added, deleted: result.deleted };
    });
}
/** Counts additions and deletions without relying on quoted Git path names. */
export function reviewChange(root, requestedBase) {
    let base = resolveCommit(root, "HEAD");
    if (requestedBase !== undefined) {
        const target = resolveCommit(root, requestedBase);
        if (!target || !base)
            throw new Error("The requested base or HEAD is not a commit.");
        base = mergeBase(root, base, target);
        if (!base)
            throw new Error("HEAD and the requested base have no common ancestor.");
    }
    const trackedArgs = base
        ? [["diff", "--numstat", "-z", "--no-renames", "--relative", base, ...PATHSPEC]]
        : [["diff", "--numstat", "-z", "--no-renames", "--relative", "--cached", ...PATHSPEC],
            ["diff", "--numstat", "-z", "--no-renames", "--relative", ...PATHSPEC]];
    const files = trackedArgs.flatMap((args) => numstat(root, args));
    const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard", ...PATHSPEC]).split("\0").filter(Boolean);
    for (const path of untracked) {
        const output = git(root, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", path], true);
        const first = output.split("\0")[0];
        if (!first) {
            files.push({ path, added: 0, deleted: 0 });
            continue;
        }
        const result = counts(first);
        files.push({ path, added: result.added, deleted: result.deleted });
    }
    return files;
}
/** Counts only the committed files in a range, without including the current working tree. */
export function reviewCommitRange(root, base, head) {
    return numstat(root, ["diff", "--numstat", "-z", "--no-renames", "--relative", base, head, ...PATHSPEC]);
}
