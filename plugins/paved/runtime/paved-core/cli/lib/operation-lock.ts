import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { AsyncLocalStorage } from "node:async_hooks";

const operationScope = new AsyncLocalStorage<string>();
const ownedProjects = new Set<string>();

/** Explicit nesting while a workflow holds its lock across asynchronous phases. */
export function withConsumerOperationScope<T>(projectRoot: string, action: () => T): T {
  if (!ownedProjects.has(projectRoot)) throw new ConsumerOperationLockedError();
  return operationScope.run(projectRoot, action);
}

export class ConsumerOperationLockedError extends Error {
  constructor() {
    super("Another Paved operation is active, or a previous operation left .paved-operation-lock behind. Inspect the lock before removing it.");
    this.name = "ConsumerOperationLockedError";
  }
}

export function acquireConsumerOperationLock(projectRoot: string, operation: string): () => void {
  if (operationScope.getStore() === projectRoot && ownedProjects.has(projectRoot)) return () => {};
  const lockPath = join(projectRoot, ".paved-operation-lock");
  // A launcher can hold the operation lock across runtime selection and delegate
  // the local update to its direct child. Unrelated processes cannot borrow it.
  const token = process.env.PAVED_PARENT_OPERATION_TOKEN;
  if (token && operation === "update") {
    const ownerPath = join(lockPath, "owner.json");
    try {
      if (!lstatSync(lockPath).isSymbolicLink() && !lstatSync(ownerPath).isSymbolicLink()) {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { operation?: string; pid?: number; token?: string };
        if (owner.operation === "auto-update" && owner.pid === process.ppid && owner.token === token && /^[a-f0-9]{48}$/.test(token)) return () => {};
      }
    } catch { /* Missing or invalid parent ownership falls through to normal acquisition. */ }
  }
  try {
    mkdirSync(lockPath);
  } catch (error) {
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
  } catch (error) {
    rmdirSync(lockPath);
    throw error;
  }

  ownedProjects.add(projectRoot);
  let released = false;
  return () => {
    if (released) return;
    const contents = readdirSync(lockPath);
    if (contents.length !== 1 || contents[0] !== "owner.json") {
      throw new Error("Consumer operation lock contains unexpected files and was preserved.");
    }
    unlinkSync(join(lockPath, "owner.json"));
    rmdirSync(lockPath);
    ownedProjects.delete(projectRoot);
    released = true;
  };
}
