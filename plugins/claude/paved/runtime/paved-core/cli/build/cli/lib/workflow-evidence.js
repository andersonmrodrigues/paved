import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadYaml } from "./documents.js";
import { coveredTypes } from "./evidence.js";
import { resolveSafePath } from "./safe-path.js";
import { runSourceRoot } from "./workflow-runs.js";
import { UNCHANGED_HANDLER } from "./workflows.js";
// Paved state is not part of the change it records.
const PATHSPEC = ["--", ".", ":(exclude).paved", ":(exclude).paved.update-backup", ":(exclude).paved-operation-lock"];
function git(projectRoot, args, input) {
    const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
    // `git diff --no-index` exits 1 when the files differ, which is the expected case.
    return { ok: result.error === undefined && (result.status === 0 || (args.includes("--no-index") && result.status === 1)), stdout: result.stdout ?? "" };
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
/** The change since the run started: committed, staged, unstaged and untracked files, against the run's revision. */
function collectChange(projectRoot, revision) {
    if (git(projectRoot, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true")
        return undefined;
    // A run started before the repository had a commit changed every file it now holds.
    const base = revision === "unversioned"
        ? undefined
        : [revision, "HEAD"].find((ref) => git(projectRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok);
    const untracked = lines(git(projectRoot, ["ls-files", "--others", "--exclude-standard", ...PATHSPEC]).stdout);
    const changed = base === undefined
        ? [...lines(git(projectRoot, ["ls-files", "--cached", ...PATHSPEC]).stdout), ...untracked]
        : [...lines(git(projectRoot, ["diff", "--name-only", base, ...PATHSPEC]).stdout), ...untracked];
    const added = base === undefined ? changed : untracked;
    let patch = base === undefined ? "" : git(projectRoot, ["diff", "--no-color", base, ...PATHSPEC]).stdout;
    for (const file of added)
        patch += git(projectRoot, ["diff", "--no-color", "--no-index", "--", "/dev/null", file]).stdout;
    return { files: [...new Set(changed)].sort((a, b) => a.localeCompare(b, "en")), patch,
        ...(base === undefined ? {} : { base: git(projectRoot, ["rev-parse", "--verify", `${base}^{commit}`]).stdout.trim() }) };
}
/**
 * The stable patch id of a diff: unchanged when the same patch is rebased onto another
 * base or split into other commits, so evidence can be matched to the patch it verified.
 */
function patchId(projectRoot, patch) {
    if (patch.trim() === "")
        return undefined;
    const id = git(projectRoot, ["patch-id", "--stable"], patch).stdout.trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : undefined;
}
/** The patch the current head would propose against `target`, computed like the recorded one. */
export function headPatch(sourceRoot, target) {
    if (target.startsWith("-") || !git(sourceRoot, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]).ok) {
        return { problem: `Target ${target} is not a revision in this repository.` };
    }
    const base = git(sourceRoot, ["merge-base", "HEAD", target]);
    if (!base.ok || base.stdout.trim() === "")
        return { problem: `HEAD and ${target} share no history.` };
    const mergeBase = base.stdout.trim();
    const id = patchId(sourceRoot, git(sourceRoot, ["diff", "--no-color", mergeBase, "HEAD", ...PATHSPEC]).stdout);
    const status = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all", ...PATHSPEC]).stdout;
    return { base: mergeBase, ...(id === undefined ? {} : { patchId: id }), uncommitted: status.trim() !== "" };
}
/**
 * Whether evidence recorded for one patch still describes the head. Verification and
 * review cover a patch, not a commit id: a rebase that keeps the patch keeps the evidence,
 * and any other difference, or a missing fingerprint, means the evidence no longer applies.
 */
export function patchFreshness(recorded, head) {
    if (recorded === undefined)
        return { fresh: false, reason: "unrecorded" };
    if (head === undefined)
        return { fresh: false, reason: "empty-head" };
    return recorded === head ? { fresh: true } : { fresh: false, reason: "patch-changed" };
}
function workflowPlan(workflow, authoritative) {
    const all = (key) => workflow.phases.flatMap((phase) => phase.verification?.[key] ?? []);
    const required = [...new Set([...all("required"), ...authoritative.plan.required])].sort();
    const recommended = [...new Set(all("recommended"))].filter((type) => !required.includes(type)).sort();
    const evidence = [...new Set([...workflow.evidence.required, ...authoritative.plan.evidence, "diff"])].sort();
    return { required, ...(recommended.length ? { recommended } : {}), evidence };
}
/**
 * Builds the workflow evidence record from what Paved already holds: the authoritative
 * verification record, the run's change and the workflow's verification plan.
 */
/**
 * The failing regression test recorded at discovery, as the reproduction a workflow such as
 * core.bug requires. Without it, a run that did reproduce the bug could not complete.
 */
function reproduction(projectRoot, run, workflow, authoritative, createdAt) {
    if (!workflow.evidence.required.includes("reproduction"))
        return [];
    if (authoritative.artifacts?.some((artifact) => artifact.kind === "reproduction"))
        return [];
    const ref = run.events.findLast((event) => event.phase === "discovery" && event.type === "evidence-recorded" && event.ref?.startsWith(".paved/generated/evidence/"))?.ref;
    if (ref === undefined)
        return [];
    const path = resolveSafePath(projectRoot, ref);
    if (!existsSync(path))
        return [];
    return [{
            id: "regression-reproduction", kind: "reproduction", description: "The regression test that failed before the fix, recorded at discovery.",
            recorded_by: "paved", revision: authoritative.change.revision, created_at: createdAt,
            source: { type: "file", location: ref, sha256: sha(readFileSync(path, "utf8")) },
        }];
}
/** The files the run changed so far, or undefined when the checkout is not a Git working tree. */
export function changedFiles(projectRoot, run) {
    return collectChange(runSourceRoot(projectRoot, run), run.revision)?.files;
}
export function writeWorkflowEvidence(input) {
    const { projectRoot, run, workflow } = input;
    if (!run.evidence)
        return { problem: "The run has no authoritative verification evidence to build on." };
    const authoritative = loadYaml(resolveSafePath(projectRoot, run.evidence));
    const change = collectChange(runSourceRoot(projectRoot, run), run.revision);
    if (!change)
        return { problem: "The project is not a Git working tree, so Paved cannot derive the change diff." };
    // Work the user confirmed was already done before the run legitimately has an empty diff.
    const preExisting = run.decisions?.some((decision) => decision.handler === UNCHANGED_HANDLER && decision.answer === "already-done") === true;
    if (change.files.length === 0 && !preExisting)
        return { problem: "No changed file was found since the run started." };
    const createdAt = new Date().toISOString();
    // Each recording gets its own files, so evidence a reopened run already recorded is never rewritten.
    const attempt = run.events.filter((event) => event.type === "evidence-recorded" && event.phase === "evidence").length + 1;
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const diffRef = `.paved/generated/evidence/${run.id}${suffix}.diff`;
    const recordRef = `.paved/generated/evidence/${run.id}-workflow${suffix}.yaml`;
    const plan = workflowPlan(workflow, authoritative);
    const patch = change.base === undefined ? undefined : patchId(runSourceRoot(projectRoot, run), change.patch);
    const covered = new Set(authoritative.checks.filter((check) => check.status === "passed").flatMap(coveredTypes));
    const profilePath = resolveSafePath(projectRoot, ".paved/verification/profile.yaml");
    const unavailable = existsSync(profilePath) ? loadYaml(profilePath).unavailable ?? [] : [];
    const gaps = (plan.recommended ?? []).filter((type) => !covered.has(type)).map((type) => ({
        check_type: type,
        description: `No ${type} check ran for this change.`,
        reason: unavailable.find((item) => item.type === type)?.reason ?? "The verification profile configures no check of this type.",
        risk: "low",
    }));
    const record = {
        apiVersion: "paved/v1", kind: "Evidence", id: `${run.id}-workflow${suffix}`, created_at: createdAt,
        producer: { agent: "paved-cli", workflow: workflow.id, run: run.id },
        verification: authoritative.verification,
        retention: "local",
        change: { ...authoritative.change, summary: preExisting && change.files.length === 0 ? `${input.summary} (already in the repository before the run started)` : input.summary, files: change.files,
            ...(patch === undefined ? {} : { patch_id: patch, patch_base: change.base }) },
        plan,
        claims: authoritative.claims,
        checks: authoritative.checks,
        artifacts: [
            ...(authoritative.artifacts ?? []),
            {
                id: "change-diff", kind: "diff", description: "Diff of the change since the run started.",
                recorded_by: "paved", revision: authoritative.change.revision, created_at: createdAt,
                source: { type: "file", location: diffRef, sha256: sha(change.patch) },
            },
            ...reproduction(projectRoot, run, workflow, authoritative, createdAt),
        ],
        ...(gaps.length ? { gaps } : {}),
        completion: authoritative.completion,
    };
    for (const [ref, content] of [[diffRef, change.patch], [recordRef, stringify(record)]]) {
        const path = resolveSafePath(projectRoot, ref);
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, content);
    }
    return { path: join(projectRoot, recordRef) };
}
