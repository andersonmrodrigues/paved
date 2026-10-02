import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { copyProjectForInitDryRun } from "../commands/init.js";
import { hashLocalTree } from "./local-core.js";
import { discoverSources } from "./generator-runtime.js";
import { acquireConsumerOperationLock } from "./operation-lock.js";
function assertNoSymlinks(root) {
    function walk(path) {
        for (const entry of readdirSync(path)) {
            const child = join(path, entry);
            const stat = lstatSync(child);
            if (stat.isSymbolicLink())
                throw new Error("Consumer .paved state contains a symbolic link; update cannot safely stage it.");
            if (stat.isDirectory())
                walk(child);
        }
    }
    walk(root);
}
/** A failed stage leaves the authoritative .paved directory untouched. */
function applyConsumerUpdateUnlocked(projectRoot, stage, options = {}) {
    const paved = join(projectRoot, ".paved");
    const recovery = join(projectRoot, ".paved.update-backup");
    if (!existsSync(paved))
        throw new Error("Consumer .paved state is missing.");
    if (lstatSync(paved).isSymbolicLink())
        throw new Error("Consumer .paved state is a symbolic link; update cannot safely stage it.");
    if (existsSync(recovery))
        throw new Error("An unfinished update backup exists at .paved.update-backup; recover it before updating.");
    assertNoSymlinks(paved);
    const before = hashLocalTree(projectRoot, [".paved"]);
    const sourceFingerprint = (root) => JSON.stringify(discoverSources(root).map((source) => [source.path, source.sha256]));
    const sourcesBefore = sourceFingerprint(projectRoot);
    const workspace = mkdtempSync(join(dirname(projectRoot), `.paved-update-${basename(projectRoot)}-`));
    const stagedRoot = join(workspace, "consumer");
    let committed = false;
    try {
        copyProjectForInitDryRun(projectRoot, stagedRoot);
        cpSync(paved, join(stagedRoot, ".paved"), { recursive: true });
        if (sourceFingerprint(stagedRoot) !== sourcesBefore)
            throw new Error("Staged repository evidence differs from the consumer; update aborted.");
        const result = stage(stagedRoot);
        if (options.commitIf && !options.commitIf(result)) {
            options.onRejected?.(stagedRoot, result);
            return result;
        }
        if (before !== hashLocalTree(projectRoot, [".paved"]) || sourcesBefore !== sourceFingerprint(projectRoot)) {
            throw new Error("Consumer state or repository evidence changed during update; retry from the new state.");
        }
        renameSync(paved, recovery);
        try {
            renameSync(join(stagedRoot, ".paved"), paved);
            committed = true;
        }
        catch (error) {
            renameSync(recovery, paved);
            throw error;
        }
        rmSync(recovery, { recursive: true, force: true });
        return result;
    }
    finally {
        // After a successful swap the old state is no longer authoritative. A failed
        // second rename restores it above; a process crash leaves the backup on disk.
        if (!committed && existsSync(recovery) && !existsSync(paved))
            renameSync(recovery, paved);
        rmSync(workspace, { recursive: true, force: true });
    }
}
export function applyConsumerUpdate(projectRoot, stage, options = {}) {
    const release = acquireConsumerOperationLock(projectRoot, "update");
    try {
        return applyConsumerUpdateUnlocked(projectRoot, stage, options);
    }
    finally {
        release();
    }
}
