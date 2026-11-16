import { spawnSync } from "node:child_process";
const AGENTS_PATH = "AGENTS.md";
export const AGENTS_VERSIONING_QUESTION = "Should the AGENTS.md that Paved maintains be versioned in this repository?";
function git(projectRoot, args) {
    return spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "ignore"] });
}
/**
 * How git treats the project's AGENTS.md, or undefined outside a git working tree
 * (including when git is not installed). A staged file counts as tracked.
 */
export function inspectAgentsVersioning(projectRoot) {
    const inside = git(projectRoot, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
    if (inside.status !== 0)
        return undefined;
    const [isWorkTree, prefix = ""] = inside.stdout.split("\n");
    if (isWorkTree?.trim() !== "true")
        return undefined;
    const repositoryPath = `${prefix.trim()}${AGENTS_PATH}`;
    const tracked = git(projectRoot, ["ls-files", "--", AGENTS_PATH]);
    if (tracked.status !== 0)
        return undefined;
    if (tracked.stdout.trim() !== "")
        return { repositoryPath, state: "tracked" };
    // check-ignore exits 0 when the path is ignored, 1 when it is not.
    const ignored = git(projectRoot, ["check-ignore", "-q", "--", AGENTS_PATH]);
    return { repositoryPath, state: ignored.status === 0 ? "ignored" : "untracked" };
}
/**
 * Asks whether the root AGENTS.md Paved maintains should be versioned. Only an untracked,
 * unignored file in a git working tree is asked about: a tracked file was already
 * versioned by the team and an ignored one was already kept local.
 */
export const agentsVersioningProvider = (context) => {
    const versioning = inspectAgentsVersioning(context.projectRoot);
    if (versioning?.state !== "untracked")
        return [];
    return [{
            scope: "project",
            question: AGENTS_VERSIONING_QUESTION,
            reason: `${versioning.repositoryPath} is not tracked by git. Paved keeps its managed block there so agents find the project's Paved setup; whether that file belongs in version control is a team choice, so Paved asks without holding up setup.`,
            options: [
                {
                    id: "track", label: "Version it",
                    description: "Leave AGENTS.md as a normal untracked file to commit with the project.",
                    consequence: "AGENTS.md shows up as a new or changed file and is committed like any other.",
                },
                {
                    id: "keep-local", label: "Keep it local",
                    description: `Add /${versioning.repositoryPath} to this clone's .git/info/exclude.`,
                    consequence: "Git ignores AGENTS.md in this clone and its worktrees; nothing tracked changes, and other clones are unaffected.",
                },
            ],
            evidence: [],
            // Optional: setup never waits on it. The block is written now, and keep-local excludes it.
            required: false,
            requiredAnswer: { type: "single-choice" },
            effect: "config-additive",
            handler: "agents.versioning",
            candidates: [`agents-untracked:${versioning.repositoryPath}`],
        }];
};
