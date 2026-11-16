import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.js";
import { inspectAgentsVersioning } from "../providers/agents.js";
/**
 * The exclude file git reads for this working tree. `--git-path` resolves it in the
 * common directory, so every linked worktree of the clone shares it.
 */
function excludeFile(projectRoot) {
    const result = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
        cwd: projectRoot, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || result.stdout.trim() === "") {
        throw new Error(`Cannot locate .git/info/exclude: ${(result.stderr ?? "").trim() || "git rev-parse failed"}.`);
    }
    return resolve(projectRoot, result.stdout.trim());
}
/** Adds the pattern unless the file already lists it; returns whether it wrote. */
export function addLocalExclude(projectRoot, pattern) {
    const path = excludeFile(projectRoot);
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === pattern))
        return false;
    mkdirSync(dirname(path), { recursive: true });
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    atomicWriteFileSync(path, `${current}${separator}${pattern}\n`);
    return true;
}
function apply(answer, context) {
    if (answer === "track")
        return [];
    if (answer !== "keep-local")
        throw new Error(`Unknown AGENTS.md versioning option: ${String(answer)}.`);
    const versioning = inspectAgentsVersioning(context.projectRoot);
    // Already ignored needs nothing; a file tracked since the question was asked stays
    // tracked whatever the exclude file says, so it is left alone too.
    if (versioning?.state !== "untracked")
        return [];
    return addLocalExclude(context.projectRoot, `/${versioning.repositoryPath}`) ? [".git/info/exclude"] : [];
}
export const agentsVersioningHandler = { effect: "config-additive", apply };
