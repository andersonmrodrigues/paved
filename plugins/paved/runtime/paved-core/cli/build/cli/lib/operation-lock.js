import { mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
export class ConsumerOperationLockedError extends Error {
    constructor() {
        super("Another Paved operation is active, or a previous operation left .paved-operation-lock behind. Inspect the lock before removing it.");
        this.name = "ConsumerOperationLockedError";
    }
}
export function acquireConsumerOperationLock(projectRoot, operation) {
    const lockPath = join(projectRoot, ".paved-operation-lock");
    try {
        mkdirSync(lockPath);
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
            throw new ConsumerOperationLockedError();
        }
        throw error;
    }
    try {
        atomicWriteFileSync(join(lockPath, "owner.json"), JSON.stringify({
            operation,
            pid: process.pid,
            started_at: new Date().toISOString(),
        }) + "\n");
    }
    catch (error) {
        rmdirSync(lockPath);
        throw error;
    }
    let released = false;
    return () => {
        if (released)
            return;
        const contents = readdirSync(lockPath);
        if (contents.length !== 1 || contents[0] !== "owner.json") {
            throw new Error("Consumer operation lock contains unexpected files and was preserved.");
        }
        unlinkSync(join(lockPath, "owner.json"));
        rmdirSync(lockPath);
        released = true;
    };
}
