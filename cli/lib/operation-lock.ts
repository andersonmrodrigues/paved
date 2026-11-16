import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { createDiagnostic, type Diagnostic } from "../result.ts";

const LOCK_NAME = ".paved-operation-lock";
const RECLAIM_NAME = `${LOCK_NAME}.reclaim`;
/**
 * A lock without a readable owner is only expected between `mkdir` and the owner write,
 * which takes milliseconds. Past this age nobody can still be acquiring it.
 */
export const OWNERLESS_LOCK_STALE_AFTER_MS = 10 * 60 * 1000;
// Files atomicWriteFileSync may leave next to owner.json when it is interrupted.
const OWNER_TEMPORARY = /^\.owner\.json\.[0-9a-f-]{36}\.tmp$/;

const operationScope = new AsyncLocalStorage<string>();
const ownedProjects = new Set<string>();

export interface OperationLockOwner {
  readonly operation?: string;
  readonly pid?: number;
  readonly started_at?: string;
  readonly host?: string;
}

type HeldReason = "running" | "other-host" | "acquiring" | "unexpected-contents" | "reclaiming" | "reclaim-interrupted" | "scope";
type StaleReason = "owner-exited" | "owner-unreadable";

export interface ReclaimedOperationLock {
  readonly projectRoot: string;
  readonly reason: StaleReason;
  readonly previous?: OperationLockOwner;
}

const reclaimedLocks: ReclaimedOperationLock[] = [];

/** Reclaimed stale locks since the last call; each is reported once as a warning. */
export function takeReclaimedOperationLocks(): ReclaimedOperationLock[] {
  return reclaimedLocks.splice(0);
}

export function reclaimedLockDiagnostics(): Diagnostic[] {
  return takeReclaimedOperationLocks().map((item) => createDiagnostic({
    severity: "warning", category: "findings", code: "PAVED_OPERATION_LOCK_RECLAIMED", component: "consumer.operation",
    message: item.reason === "owner-exited"
      ? `Reclaimed ${LOCK_NAME} left by ${describeOwner(item.previous)}; that process is no longer running.`
      : `Reclaimed ${LOCK_NAME} that had no readable owner.json for more than ${OWNERLESS_LOCK_STALE_AFTER_MS / 60000} minutes.`,
    remediation: "Nothing to do unless that operation was interrupted while writing; run paved status --json to check the project state.",
  }));
}

/** Explicit nesting while a workflow holds its lock across asynchronous phases. */
export function withConsumerOperationScope<T>(projectRoot: string, action: () => T): T {
  if (!ownedProjects.has(projectRoot)) throw new ConsumerOperationLockedError("scope");
  return operationScope.run(projectRoot, action);
}

export class ConsumerOperationLockedError extends Error {
  readonly reason: HeldReason;
  readonly owner: OperationLockOwner | undefined;
  readonly remediation: string;

  constructor(reason: HeldReason, owner?: OperationLockOwner) {
    super(heldMessage(reason, owner));
    this.name = "ConsumerOperationLockedError";
    this.reason = reason;
    this.owner = owner;
    this.remediation = heldRemediation(reason, owner);
  }
}

function describeOwner(owner: OperationLockOwner | undefined): string {
  if (owner === undefined) return "an unknown operation";
  const host = owner.host === undefined || owner.host === hostname() ? "" : ` on host ${owner.host}`;
  return `${owner.operation ?? "an unknown operation"} (pid ${owner.pid ?? "unknown"}${host}, started ${owner.started_at ?? "at an unknown time"})`;
}

function heldMessage(reason: HeldReason, owner: OperationLockOwner | undefined): string {
  switch (reason) {
    case "running": return `Another Paved operation is active: ${describeOwner(owner)} holds ${LOCK_NAME} and is still running.`;
    case "other-host": return `${LOCK_NAME} is held by ${describeOwner(owner)}; Paved cannot tell from this host whether that process is still running.`;
    case "acquiring": return `${LOCK_NAME} has no readable owner.json yet; another Paved operation may be acquiring it.`;
    case "unexpected-contents": return `${LOCK_NAME} is not a lock Paved wrote (it is a link, or holds unexpected files), so it was preserved.`;
    case "reclaiming": return `Another Paved operation is reclaiming a stale ${LOCK_NAME} left by ${describeOwner(owner)}.`;
    case "reclaim-interrupted": return `A previous reclamation of ${LOCK_NAME} was interrupted and left ${RECLAIM_NAME} behind; the lock left by ${describeOwner(owner)} was preserved.`;
    case "scope": return "No Paved operation lock is held by this process for the project.";
  }
}

function heldRemediation(reason: HeldReason, owner: OperationLockOwner | undefined): string {
  switch (reason) {
    case "running": return `Wait for ${owner?.operation ?? "that operation"} to finish, then retry.`;
    case "other-host": return `Confirm that no Paved process on ${owner?.host ?? "that host"} still uses this project, then remove ${LOCK_NAME} and retry.`;
    case "acquiring": return `Retry in a moment. A lock that stays ownerless for ${OWNERLESS_LOCK_STALE_AFTER_MS / 60000} minutes is reclaimed automatically.`;
    case "unexpected-contents": return `Inspect ${LOCK_NAME}; remove it only after confirming no Paved process is active.`;
    case "reclaiming": return "Retry in a moment.";
    case "reclaim-interrupted": return `Confirm that no Paved process is active, then remove ${RECLAIM_NAME} and retry; the stale lock is then reclaimed automatically.`;
    case "scope": return "Acquire the operation lock before entering its scope.";
  }
}

type Observation =
  | { readonly kind: "absent" }
  | { readonly kind: "held"; readonly reason: HeldReason; readonly owner?: OperationLockOwner }
  | { readonly kind: "stale"; readonly reason: StaleReason; readonly owner?: OperationLockOwner;
      readonly entries: readonly string[]; readonly identity: string };

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Only fields of the expected shape are trusted; anything else reads as absent. */
function parseOwner(raw: string): OperationLockOwner | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = (field: unknown, pattern: RegExp): string | undefined => typeof field === "string" && pattern.test(field) ? field : undefined;
  const operation = text(record.operation, /^[\w:.-]{1,120}$/);
  const startedAt = text(record.started_at, /^[\d:.TZ+-]{1,40}$/);
  const host = text(record.host, /^[\w.-]{1,255}$/);
  const pid = typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  return {
    ...(operation === undefined ? {} : { operation }),
    ...(pid === undefined ? {} : { pid }),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(host === undefined ? {} : { host }),
  };
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists under another user; anything but ESRCH is treated as alive.
    return errorCode(error) !== "ESRCH";
  }
}

function observe(lockPath: string): Observation {
  const directory = statOrUndefined(lockPath);
  if (directory === undefined) return { kind: "absent" };
  if (!directory.isDirectory()) return { kind: "held", reason: "unexpected-contents" };
  const entries = readdirSync(lockPath, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || (entry.name !== "owner.json" && !OWNER_TEMPORARY.test(entry.name)))) {
    return { kind: "held", reason: "unexpected-contents" };
  }
  const ownerPath = join(lockPath, "owner.json");
  const ownerStat = statOrUndefined(ownerPath);
  let raw: string | undefined;
  if (ownerStat !== undefined) {
    try { raw = readFileSync(ownerPath, "utf8"); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
  const owner = raw === undefined ? undefined : parseOwner(raw);
  const names = entries.map((entry) => entry.name).sort();
  // Inode plus exact owner bytes: a lock recreated in between never matches an earlier observation.
  const identity = `${directory.dev}:${directory.ino}:${raw ?? ""}`;
  if (owner?.pid !== undefined) {
    if (owner.host !== undefined && owner.host !== hostname()) return { kind: "held", reason: "other-host", owner };
    if (processRunning(owner.pid)) return { kind: "held", reason: "running", owner };
    return { kind: "stale", reason: "owner-exited", owner, entries: names, identity };
  }
  const touched = Math.max(directory.mtimeMs, ownerStat?.mtimeMs ?? 0);
  if (Date.now() - touched < OWNERLESS_LOCK_STALE_AFTER_MS) return { kind: "held", reason: "acquiring", ...(owner === undefined ? {} : { owner }) };
  return { kind: "stale", reason: "owner-unreadable", ...(owner === undefined ? {} : { owner }), entries: names, identity };
}

function heldError(observation: Observation): ConsumerOperationLockedError {
  if (observation.kind === "held") return new ConsumerOperationLockedError(observation.reason, observation.owner);
  // A stale or vanished lock seen after losing a race: another process is reclaiming it.
  return new ConsumerOperationLockedError("reclaiming", observation.kind === "stale" ? observation.owner : undefined);
}

/**
 * Removes a stale lock under a separate exclusive marker. Every reclaimer re-observes
 * the lock while holding the marker and removes it only when it is the very lock judged
 * stale, so two processes can never both reclaim, and a fresh lock is never removed.
 */
function reclaim(projectRoot: string, lockPath: string, observed: Extract<Observation, { kind: "stale" }>): ReclaimedOperationLock | undefined {
  const marker = join(projectRoot, RECLAIM_NAME);
  try {
    mkdirSync(marker);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const left = statOrUndefined(marker);
    const interrupted = left !== undefined && Date.now() - left.mtimeMs >= OWNERLESS_LOCK_STALE_AFTER_MS;
    throw new ConsumerOperationLockedError(interrupted ? "reclaim-interrupted" : "reclaiming", observed.owner);
  }
  try {
    const current = observe(lockPath);
    if (current.kind === "absent") return undefined;
    if (current.kind !== "stale" || current.identity !== observed.identity) throw heldError(current);
    for (const name of current.entries) unlinkSync(join(lockPath, name));
    rmdirSync(lockPath);
  } finally {
    try { rmdirSync(marker); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
  return { projectRoot, reason: observed.reason, ...(observed.owner === undefined ? {} : { previous: observed.owner }) };
}

function createLock(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

export function acquireConsumerOperationLock(projectRoot: string, operation: string): () => void {
  if (operationScope.getStore() === projectRoot && ownedProjects.has(projectRoot)) return () => {};
  const lockPath = join(projectRoot, LOCK_NAME);
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

  let reclaimed: ReclaimedOperationLock | undefined;
  if (!createLock(lockPath)) {
    const observed = observe(lockPath);
    if (observed.kind === "held") throw heldError(observed);
    if (observed.kind === "stale") reclaimed = reclaim(projectRoot, lockPath, observed);
    // Whoever creates the lock first after it disappears owns it; no second reclamation.
    if (!createLock(lockPath)) throw heldError(observe(lockPath));
  }

  try {
    atomicWriteFileSync(join(lockPath, "owner.json"), JSON.stringify({
      operation,
      pid: process.pid,
      host: hostname(),
      started_at: new Date().toISOString(),
    }) + "\n");
  } catch (error) {
    rmdirSync(lockPath);
    throw error;
  }
  if (reclaimed !== undefined) reclaimedLocks.push(reclaimed);

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
