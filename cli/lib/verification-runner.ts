import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { createDiagnostic, type Diagnostic } from "../result.ts";
import { globRegex } from "./adapters.ts";
import { loadYaml } from "./documents.ts";
import {
  assessEvidence,
  evaluateCompletion,
  loadEvidenceRegistry,
  type CheckDefinition,
  type EvidenceRecord,
  type VerificationPolicy,
} from "./evidence.ts";
import { createRegistry, type SchemaRegistry } from "./schemas.ts";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { acquireConsumerOperationLock, ConsumerOperationLockedError } from "./operation-lock.ts";
import { failureExcerpt, isPreExisting, ROOT_PLACEHOLDER, withBaseWorktree } from "./verification-baseline.ts";
import { orderChecks } from "./verification-order.ts";
import { resolveSafePath } from "./safe-path.ts";
import {
  authorizeTool,
  buildArgv,
  captureToolExecution,
  resolveTool,
  type ToolInvocation,
  sanitizeToolOutput,
  sensitiveArgvInputNames,
  toEvidenceCheck,
  validateImplementation,
  validateTool,
  validateToolInputs,
  validateToolResult,
  type ToolContract,
  type ToolImplementation,
} from "./tools.ts";

const OUTPUT_LIMIT_BYTES = 16 * 1024;
const RUNTIME_VERSION = "paved-cli-verification-runner/0.1.0";
// Process basics plus the variables that select a toolchain. Without them a check runs on
// whatever the launcher finds first (for example the newest JDK), not the one the user chose.
// Credentials and tokens are never forwarded.
export const verificationEnvironmentAllowlist = new Set([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "JAVA_HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "GRADLE_USER_HOME",
  "CHROME_BIN",
]);

/**
 * The environment a governed check runs in: allowlisted variables, the variables the check
 * itself declares in `environment.requires`, and a non-interactive CI mode.
 */
export function verificationEnvironment(source: NodeJS.ProcessEnv = process.env, required: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const declared = new Set(required);
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (verificationEnvironmentAllowlist.has(name.toUpperCase()) || declared.has(name))) env[name] = value;
  }
  // Test runners that would otherwise watch for changes or prompt exit after one run.
  env.CI = "true";
  return env;
}

interface VerificationProfile {
  readonly checks: readonly string[];
  readonly policy?: VerificationPolicy;
  readonly unavailable?: readonly { type: string; reason: string }[];
}

interface CheckContract extends CheckDefinition {
  readonly title: string;
  readonly purpose: string;
  readonly expected: { readonly exit_code?: number; readonly description?: string; readonly measurement?: unknown };
  readonly inputs?: Record<string, unknown>;
  readonly preconditions?: readonly { id: string; condition: string; when_unmet: "blocked" | "skipped" }[];
  readonly timeout_seconds?: number;
  readonly applies_to?: readonly string[];
  readonly depends_on?: readonly string[];
  readonly environment?: { readonly requires?: { readonly files?: readonly string[]; readonly variables?: readonly string[] } };
}

export interface VerificationRunInput {
  readonly projectRoot: string;
  /** Where Checks run and the revision is read; defaults to projectRoot. */
  readonly sourceRoot?: string;
  readonly coreRoot: string;
  readonly adapterSelections?: readonly string[];
  readonly beforeRun?: (invocations: readonly ToolInvocation[]) => void;
  /** The files a workflow run changed; a Check whose `applies_to` matches none of them is skipped. Omitted runs every Check. */
  readonly changedFiles?: readonly string[];
  /** The commit a failing Check is compared with to decide whether its failure is pre-existing. */
  readonly baseRevision?: string;
  /** How long to wait for another operation's lock before giving up; a run it finishes for the same change is reused. */
  readonly lockWaitMs?: number;
  /**
   * Never run a Check: return the newest record for this change and configuration, passing or
   * not, or PAVED_VERIFY_NOT_RECORDED. A change no Check applies to is still recorded, since
   * nothing runs. Lets a lifecycle hook answer in seconds however slow the suite is.
   */
  readonly recordedOnly?: boolean;
}

/** Why the change does not concern the check, or undefined when it does. */
function irrelevance(check: CheckContract, changedFiles: readonly string[] | undefined): string | undefined {
  if (changedFiles === undefined || check.applies_to === undefined || check.applies_to.length === 0) return undefined;
  const patterns = check.applies_to.map(globRegex);
  if (changedFiles.some((file) => patterns.some((pattern) => pattern.test(file)))) return undefined;
  return `No changed file matches applies_to (${check.applies_to.join(", ")}).`;
}

export type UnprovenReason = "pre-existing" | "environment-unavailable" | "dependency-unproven";

export interface CheckSummary {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly output_ref?: string;
  readonly reason?: string;
  readonly excerpt?: readonly string[];
  readonly pre_existing?: true;
  readonly base_output_ref?: string;
}

/** A Check that did not pass for a reason outside the change: it is listed, never counted as passed. */
export interface UnprovenCheck {
  readonly id: string;
  readonly status: string;
  readonly reason: UnprovenReason;
  readonly output_ref?: string;
  readonly base_output_ref?: string;
  readonly missing?: { readonly files?: readonly string[]; readonly variables?: readonly string[] };
  readonly blocked_by?: readonly string[];
}

export interface VerificationRunResult {
  /** `warning`: nothing passed that should not have, but some Checks are unproven for reasons outside the change. */
  readonly status: "success" | "warning" | "failed";
  readonly diagnostics: readonly Diagnostic[];
  readonly evidenceFiles: readonly string[];
  readonly evidence?: EvidenceRecord;
  readonly evaluation?: ReturnType<typeof evaluateCompletion>;
  readonly checks: readonly CheckSummary[];
  readonly unproven?: readonly UnprovenCheck[];
  /** The result repeats an earlier verified record for the same change and configuration instead of running Checks. */
  readonly reused?: boolean;
}

type DocumentKind = "Check" | "Tool" | "ToolImplementation";
type Roots = {
  readonly checks: readonly string[];
  readonly tools: readonly string[];
  readonly implementations: readonly string[];
};

let evidenceCounter = 0;

function diagnostic(input: {
  readonly code: string;
  readonly category: Diagnostic["category"];
  readonly severity?: Diagnostic["severity"];
  readonly component: string;
  readonly message: string;
  readonly remediation?: string;
}): Diagnostic {
  return createDiagnostic({
    severity: input.severity ?? (input.category === "findings" ? "warning" : "error"),
    category: input.category,
    code: input.code,
    component: input.component,
    message: input.message,
    ...(input.remediation === undefined ? {} : { remediation: input.remediation }),
  });
}

function safe(root: string, path: string): string {
  return resolveSafePath(root, path);
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function supportedApiVersions(coreRoot: string): readonly string[] {
  try {
    const manifest = loadYaml(join(coreRoot, "manifest.yaml")) as { supported_api_versions?: unknown };
    return Array.isArray(manifest.supported_api_versions) && manifest.supported_api_versions.every((item) => typeof item === "string")
      ? manifest.supported_api_versions
      : ["paved/v1"];
  } catch {
    return ["paved/v1"];
  }
}

function registry(coreRoot: string): SchemaRegistry {
  return createRegistry(join(coreRoot, "schemas"), supportedApiVersions(coreRoot));
}

function validateDocument<T>(
  schemaRegistry: SchemaRegistry,
  file: string,
  expectedKind: DocumentKind | "VerificationProfile",
  diagnostics: Diagnostic[],
): T | undefined {
  try {
    const document = loadYaml(file);
    const validation = schemaRegistry.validate(document);
    const kind = document !== null && typeof document === "object" ? (document as { kind?: unknown }).kind : undefined;
    if (!validation.valid || kind !== expectedKind) {
      diagnostics.push(diagnostic({
        code: `PAVED_VERIFY_${expectedKind.toUpperCase()}_INVALID`,
        category: "config",
        component: "verification.config",
        message: `${file} is not a valid ${expectedKind} document.`,
        remediation: validation.errors.join("; ") || `Expected kind ${expectedKind}.`,
      }));
      return undefined;
    }
    return document as T;
  } catch {
    diagnostics.push(diagnostic({
      code: `PAVED_VERIFY_${expectedKind.toUpperCase()}_INVALID`,
      category: "config",
      component: "verification.config",
      message: `${file} cannot be parsed or read.`,
    }));
    return undefined;
  }
}

function yamlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

function findDocument<T extends { id: string }>(
  roots: readonly string[],
  id: string,
  kind: DocumentKind,
  schemaRegistry: SchemaRegistry,
  diagnostics: Diagnostic[],
): T | undefined {
  const matches: T[] = [];
  for (const root of roots) {
    for (const file of yamlFiles(root)) {
      const raw = loadContentDocument(file, kind, diagnostics);
      if (raw === undefined || raw.kind !== kind || raw.id !== id) continue;
      const document = validateDocument<T>(schemaRegistry, file, kind, diagnostics);
      if (document !== undefined) matches.push(document);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    diagnostics.push(diagnostic({
      code: `PAVED_VERIFY_${kind.toUpperCase()}_AMBIGUOUS`,
      category: "config",
      component: "verification.config",
      message: `${kind} ${id} is declared more than once in selected Paved content roots.`,
    }));
  }
  return undefined;
}

function loadContentDocument(
  file: string,
  kind: DocumentKind,
  diagnostics: Diagnostic[],
): Record<string, unknown> | undefined {
  try {
    const document = loadYaml(file);
    if (document !== null && typeof document === "object" && !Array.isArray(document)) {
      return document as Record<string, unknown>;
    }
  } catch {
    // Report malformed content uniformly without exposing parser internals.
  }
  const code = `PAVED_VERIFY_${kind.toUpperCase()}_INVALID`;
  const message = `${file} is not a valid ${kind} document.`;
  if (diagnostics.some((item) => item.code === code && item.message === message)) return undefined;
  diagnostics.push(diagnostic({
    code,
    category: "config",
    component: "verification.config",
    message,
    remediation: "Fix the YAML syntax or ensure the file contains a mapping document.",
  }));
  return undefined;
}

function findImplementations(
  roots: readonly string[],
  toolId: string,
  schemaRegistry: SchemaRegistry,
  diagnostics: Diagnostic[],
): ToolImplementation[] {
  const implementations: ToolImplementation[] = [];
  for (const root of roots) {
    for (const file of yamlFiles(root)) {
      const raw = loadContentDocument(file, "ToolImplementation", diagnostics);
      if (raw === undefined) continue;
      if (raw.kind !== "ToolImplementation" || raw.tool !== toolId) continue;
      const document = validateDocument<ToolImplementation>(schemaRegistry, file, "ToolImplementation", diagnostics);
      if (document !== undefined) implementations.push(document);
    }
  }
  return implementations;
}

function manifestAdapters(projectRoot: string): string[] {
  const manifestPath = join(projectRoot, ".paved/manifest.yaml");
  if (!existsSync(manifestPath)) return [];
  try {
    const manifest = loadYaml(manifestPath) as { adapters?: readonly { id?: unknown }[] };
    return (manifest.adapters ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function contentRoots(input: VerificationRunInput): Roots {
  const selectedAdapters = input.adapterSelections?.length
    ? [...input.adapterSelections]
    : manifestAdapters(input.projectRoot);
  const adapterRoots = selectedAdapters.map((id) => safe(input.coreRoot, join("adapters", id)));

  return {
    checks: [
      safe(input.coreRoot, "core/verification/checks"),
      ...adapterRoots.map((root) => join(root, "verification/checks")),
      safe(input.projectRoot, ".paved/verification/checks"),
    ],
    tools: [
      safe(input.coreRoot, "core/tools"),
      ...adapterRoots.map((root) => join(root, "tools")),
      safe(input.projectRoot, ".paved/tools"),
    ],
    implementations: [
      safe(input.coreRoot, "core/tool-implementations"),
      ...adapterRoots.map((root) => join(root, "tool-implementations")),
      safe(input.projectRoot, ".paved/tool-implementations"),
    ],
  };
}

export interface WorktreeFingerprint {
  readonly revision: string;
  readonly uncommitted: boolean;
  readonly worktreeSha?: string;
}

function excludedFingerprintPath(path: string): boolean {
  return path === ".git" || path.startsWith(`.git${sep}`)
    || path === ".paved/generated" || path.startsWith(`.paved${sep}generated${sep}`)
    || path === ".paved/tasks" || path.startsWith(`.paved${sep}tasks${sep}`)
    || path === ".paved-operation-lock" || path.startsWith(`.paved-operation-lock${sep}`);
}

function stableContent(path: string | Buffer, before: Stats): Buffer {
  let content: Buffer;
  if (before.isSymbolicLink()) {
    content = readlinkSync(path, { encoding: "buffer" });
  } else if (before.isFile()) {
    if (typeof constants.O_NOFOLLOW !== "number") throw new Error("Cannot safely open a file.");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("File changed while reading.");
      content = readFileSync(fd);
      const after = fstatSync(fd);
      if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
        throw new Error("File changed while reading.");
      }
    } finally {
      closeSync(fd);
    }
  } else {
    throw new Error("Cannot fingerprint a non-file.");
  }
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("File changed while reading.");
  }
  return content;
}

function fingerprintUnversionedTree(projectRoot: string): WorktreeFingerprint {
  const digest = createHash("sha256");
  digest.update("\0root\0").update(realpathSync(projectRoot));
  const walk = (directory: string, prefix: string): void => {
    const before = lstatSync(directory);
    if (!before.isDirectory()) throw new Error("Cannot fingerprint a non-directory.");
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (excludedFingerprintPath(path.split("/").join(sep))) continue;
      const absolute = join(directory, name);
      const entry = lstatSync(absolute);
      const normalized = path.split(sep).join("/");
      if (entry.isDirectory()) {
        digest.update("\0directory\0").update(String(Buffer.byteLength(normalized))).update("\0").update(normalized)
          .update("\0").update(String(entry.mode)).update("\0");
        walk(absolute, path);
      } else {
        const content = stableContent(absolute, entry);
        digest.update("\0entry\0").update(String(Buffer.byteLength(normalized))).update("\0").update(normalized)
          .update("\0").update(String(entry.mode)).update("\0").update(String(content.length)).update("\0").update(content);
      }
    }
    const after = lstatSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Directory changed while reading.");
    }
  };
  walk(projectRoot, "");
  return { revision: "unversioned", uncommitted: true, worktreeSha: digest.digest("hex") };
}

export function fingerprintWorktree(projectRoot: string): WorktreeFingerprint {
  const git = (args: string[]) => spawnSync("git", args, {
    cwd: projectRoot, shell: false, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
  });
  const repository = git(["rev-parse", "--is-inside-work-tree"]);
  if (repository.error) throw new Error("Cannot determine whether the project is in Git.");
  if (repository.status !== 0) {
    if (!repository.stderr?.toString("utf8").includes("not a git repository")) {
      throw new Error("Cannot determine whether the project is in Git.");
    }
    return fingerprintUnversionedTree(projectRoot);
  }
  if (repository.stdout?.toString("utf8").trim() !== "true") throw new Error("The project is not a Git working tree.");
  const head = git(["rev-parse", "HEAD"]);
  if (head.error) throw new Error("Cannot determine the Git revision.");
  const hasHead = head.status === 0 && Boolean(head.stdout?.toString("utf8").trim());
  if (!hasHead) {
    const branch = git(["symbolic-ref", "-q", "HEAD"]);
    if (branch.error || branch.status !== 0 || !branch.stdout?.toString("utf8").trim()) {
      throw new Error("Cannot determine the Git revision.");
    }
  }
  const revision = hasHead ? head.stdout!.toString("utf8").trim() : "unversioned";
  const pathspec = ["--", ".", ":(exclude).paved/generated", ":(exclude).paved/tasks", ":(exclude).paved-operation-lock"];
  const status = git(["status", "--porcelain=v1", "--untracked-files=all", ...pathspec]);
  const staged = git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", ...pathspec]);
  const unstaged = git(["diff", "--binary", "--no-ext-diff", "--no-textconv", ...pathspec]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]);
  if (status.status !== 0 || staged.status !== 0 || unstaged.status !== 0 || untracked.status !== 0
    || !status.stdout || !staged.stdout || !unstaged.stdout || !untracked.stdout) {
    throw new Error("Cannot determine the working tree fingerprint.");
  }
  if (status.stdout.length === 0) return { revision, uncommitted: false };
  const digest = createHash("sha256").update("\0root\0").update(realpathSync(projectRoot))
    .update(status.stdout).update("\n").update(staged.stdout).update("\n").update(unstaged.stdout);
  const entries = untracked.stdout;
  for (let start = 0; start < entries.length;) {
    const end = entries.indexOf(0, start);
    if (end < 0 || end === start) throw new Error("Cannot parse untracked file paths.");
    const name = entries.subarray(start, end);
    const path = Buffer.concat([Buffer.from(`${projectRoot}${sep}`), name]);
    const before = lstatSync(path);
    const content = stableContent(path, before);
    digest.update("\0untracked\0").update(String(name.length)).update("\0").update(name)
      .update("\0").update(String(before.mode)).update("\0").update(String(content.length)).update("\0").update(content);
    start = end + 1;
  }
  return { revision, uncommitted: true, worktreeSha: digest.digest("hex") };
}

/**
 * The Git tree id of the content under `sourceRoot` as it is on disk, staged or not,
 * without generated Paved state. It is computed in a temporary copy of the index, so the
 * real index is untouched, and it equals the tree of a commit that captures the same
 * content. Undefined outside Git or when Git cannot compute it.
 */
export function contentTreeId(sourceRoot: string): string | undefined {
  const git = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync("git", args, {
    cwd: sourceRoot, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
    env: { ...process.env, LC_ALL: "C", ...env },
  });
  const located = git(["rev-parse", "--git-path", "index", "--show-prefix"]);
  if (located.error || located.status !== 0) return undefined;
  const [indexPath, prefix = ""] = located.stdout.split("\n");
  if (!indexPath) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "paved-tree-"));
  try {
    const index = join(scratch, "index");
    // Starting from the real index keeps Git's stat cache, so unchanged files are not hashed again.
    if (existsSync(resolve(sourceRoot, indexPath))) copyFileSync(resolve(sourceRoot, indexPath), index);
    const env = { GIT_INDEX_FILE: index };
    // Git refuses an exclusion that names an ignored path, and add skips ignored paths anyway.
    const exclusions = [".paved/generated", ".paved/tasks", ".paved-operation-lock"]
      .filter((path) => git(["check-ignore", "-q", "--", path]).status !== 0)
      .map((path) => `:(exclude)${path}`);
    const added = git(["add", "--all", "--", ".", ...exclusions], env);
    if (added.error || added.status !== 0) return undefined;
    const written = git(["write-tree"], env);
    if (written.error || written.status !== 0) return undefined;
    const root = written.stdout.trim();
    const subtree = prefix.trim() === "" ? { stdout: root, status: 0 } : git(["rev-parse", `${root}:${prefix.trim().replace(/\/$/, "")}`]);
    const id = subtree.status === 0 ? subtree.stdout.trim() : "";
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? id : undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Keeps the start and the end of one output stream within its share of the limit. Test
 * runners and builds print their failure summary last, so the end matters most.
 */
class BoundedOutput {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);
  private total = 0;
  private readonly headLimit = OUTPUT_LIMIT_BYTES / 8;
  private readonly tailLimit = (OUTPUT_LIMIT_BYTES * 3) / 8;

  add(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const taken = rest.subarray(0, this.headLimit - this.headBytes);
      this.head.push(taken);
      this.headBytes += taken.length;
      rest = rest.subarray(taken.length);
    }
    if (rest.length > 0) {
      const joined = Buffer.concat([this.tail, rest]);
      this.tail = joined.length > this.tailLimit ? joined.subarray(joined.length - this.tailLimit) : joined;
    }
  }

  get truncated(): boolean {
    return this.total > this.headBytes + this.tail.length;
  }

  text(): string {
    const omitted = this.total - this.headBytes - this.tail.length;
    const head = Buffer.concat(this.head).toString("utf8");
    return omitted > 0 ? `${head}\n[... ${omitted} bytes omitted ...]\n${this.tail.toString("utf8")}` : head + this.tail.toString("utf8");
  }
}

function evidenceCheckId(checkId: string): string {
  const prefix = checkId.toLowerCase().replaceAll(".", "_").replace(/[^a-z0-9_-]/g, "-").slice(0, 220).replace(/[-_]+$/g, "") || "check";
  return `${prefix}-${sha(checkId).slice(0, 12)}-run`;
}

export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return true;
    }
    return child.kill(signal);
  } catch (error) {
    // macOS reports EPERM instead of ESRCH when the group only holds an exited, unreaped child.
    if (error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")) return false;
    throw error;
  }
}

export async function spawnApproved(args: {
  executable: string;
  argv: string[];
  cwd: string;
  timeoutSeconds: number;
  /** Variable names the check declares it needs, passed through besides the allowlist. */
  requiredVariables?: readonly string[];
}): Promise<{
  kind: "completed" | "timeout" | "launch-error";
  exitCode?: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  const env = verificationEnvironment(process.env, args.requiredVariables ?? []);

  return new Promise((resolveRun) => {
    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let settled = false;
    let timedOut = false;

    const child = spawn(args.executable, args.argv, {
      cwd: args.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const signalGroup = (signal: NodeJS.Signals): boolean => signalProcessGroup(child, signal);
    const signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];
    const forwardSignal = (signal: NodeJS.Signals, exitCode: number): void => {
      signalGroup(signal);
      signalGroup("SIGKILL");
      process.exit(exitCode);
    };
    for (const [signal, exitCode] of [
      ...(process.platform === "win32" ? [] : [["SIGHUP", 129]]),
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ...(process.platform === "win32" ? [] : [["SIGQUIT", 131]]),
    ] as [NodeJS.Signals, number][]) {
      const handler = () => forwardSignal(signal, exitCode);
      signalHandlers.push({ signal, handler });
      process.once(signal, handler);
    }
    const finish = (code: number | null, kind?: "launch-error"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler);
      child.stdout.destroy();
      child.stderr.destroy();
      resolveRun({
        kind: kind ?? (timedOut ? "timeout" : "completed"),
        ...(code === null ? {} : { exitCode: code }),
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (signalGroup("SIGTERM")) setTimeout(() => signalGroup("SIGKILL"), 1_000);
      finish(null);
    }, Math.max(1, args.timeoutSeconds) * 1_000);

    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.on("error", () => {
      finish(null, "launch-error");
    });
    child.on("exit", (code) => {
      if (!settled) {
        if (signalGroup("SIGTERM")) setTimeout(() => signalGroup("SIGKILL"), 1_000);
      }
      finish(code);
    });
  });
}

function parseToolOutput(tool: ToolContract, stdout: string): { output: unknown; problems: string[] } {
  if (tool.outputs.format === "text") return { output: stdout, problems: [] };
  if (tool.outputs.format === "none") return { output: undefined, problems: [] };
  if (tool.outputs.format === "json") {
    try {
      return { output: JSON.parse(stdout) as unknown, problems: [] };
    } catch {
      return { output: undefined, problems: [`${tool.id} stdout is not valid JSON for its declared output format`] };
    }
  }
  if (tool.outputs.format === "yaml") {
    try {
      return { output: parseYaml(stdout) as unknown, problems: [] };
    } catch {
      return { output: undefined, problems: [`${tool.id} stdout is not valid YAML for its declared output format`] };
    }
  }
  return { output: stdout, problems: [] };
}

function stderrMessages(stderr: string, secretValues: readonly string[]): { warnings: string[]; errors: string[] } {
  if (stderr.trim().length === 0) return { warnings: [], errors: [] };
  const sanitized = sanitizeToolOutput(stderr, [...secretValues]) as string;
  return {
    warnings: [`Verification command wrote to stderr:\n${sanitized}`],
    errors: [`Verification command wrote to stderr:\n${sanitized}`],
  };
}

function evidenceId(): string {
  evidenceCounter += 1;
  return `verify-${new Date().toISOString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${process.pid}-${evidenceCounter}`;
}

function claimTypeFor(checkTypes: readonly string[]): EvidenceRecord["claims"][number]["type"] {
  if (checkTypes.some((type) => ["unit", "integration", "e2e", "runtime", "database", "deployment", "observability"].includes(type))) return "non-regression";
  if (checkTypes.some((type) => ["security", "formal"].includes(type))) return "security";
  if (checkTypes.includes("performance")) return "performance";
  if (checkTypes.some((type) => ["static-analysis", "architecture", "contract", "configuration"].includes(type))) return "structure";
  return "documentation";
}

function buildEvidence(args: {
  projectRoot: string;
  sourceRoot: string;
  coreRoot: string;
  profilePath: string;
  profileSha: string;
  configurationSha: string;
  policy?: VerificationPolicy;
  checks: readonly CheckContract[];
  evidenceChecks: EvidenceRecord["checks"];
  outputLogs: readonly { relativePath: string; content: string }[];
  change: WorktreeFingerprint;
  treeId?: string;
  baseRevision?: string;
}): { record: EvidenceRecord; evaluation: ReturnType<typeof evaluateCompletion> } {
  const now = new Date().toISOString();
  const change = args.change;
  const id = evidenceId();
  // A Check the change does not concern is on record as skipped, but neither required nor counted.
  const ran = args.evidenceChecks.filter((check) => check.status !== "skipped");
  const skipped = new Set(args.evidenceChecks.filter((check) => check.status === "skipped").map((check) => check.check));
  const checkTypes = [...new Set(args.checks.filter((check) => !skipped.has(check.id)).map((check) => check.type))].sort();
  const checkIds = ran.map((check) => check.id);
  const met = ran.length > 0 && ran.every((check) => check.status === "passed");
  const record = {
    apiVersion: "paved/v1",
    kind: "Evidence",
    id,
    created_at: now,
    producer: { agent: "paved-cli" },
    verification: {
      profile: ".paved/verification/profile.yaml",
      profile_sha256: args.profileSha,
      configuration_sha256: args.configurationSha,
      ...(args.baseRevision === undefined ? {} : { base_revision: args.baseRevision }),
    },
    retention: "local",
    change: {
      summary: "Local Paved verification run.",
      revision: change.revision,
      ...(change.uncommitted ? { uncommitted_changes: true, worktree_sha256: change.worktreeSha ?? sha("unknown-worktree") } : {}),
      ...(args.treeId === undefined ? {} : { tree_id: args.treeId }),
    },
    plan: {
      required: checkTypes,
      evidence: ["check-result"],
    },
    claims: [
      {
        id: "configured-verification",
        statement: "The configured verification checks were executed by the Paved runner.",
        type: claimTypeFor(checkTypes),
        supported_by: checkIds.length > 0 ? checkIds : ["missing-check-result"],
      },
    ],
    checks: args.evidenceChecks,
    artifacts: args.outputLogs.map((log, index) => ({
      id: `check-output-${index + 1}`,
      kind: "log",
      description: "Sanitized verification command output.",
      recorded_by: "paved",
      revision: change.revision,
      created_at: now,
      source: {
        type: "file",
        location: log.relativePath,
        sha256: sha(log.content),
      },
    })),
    completion: {
      status: "incomplete",
      verification: "unverified",
      decided_by: "paved",
      criteria: [
        {
          statement: "Every required configured check passed.",
          met,
          ...(checkIds.length > 0 ? { supported_by: checkIds } : {}),
        },
      ],
    },
  } as unknown as EvidenceRecord;

  for (const check of record.checks) {
    check.execution.revision = change.revision;
    if (change.uncommitted) {
      check.execution.worktree_sha256 = change.worktreeSha ?? sha("unknown-worktree");
    }
  }

  const definitions = new Map(args.checks.map((check) => [check.id, check]));
  const registryData = loadEvidenceRegistry(join(args.coreRoot, "core/verification/registry.yaml"));
  const evaluation = evaluateCompletion(record, registryData, args.policy ?? {}, definitions);
  record.completion = ({
    status: evaluation.status,
    verification: evaluation.verification,
    decided_by: "paved",
    criteria: [
      {
        statement: "Every required configured check passed.",
        met: evaluation.status === "complete",
        ...(checkIds.length > 0 ? { supported_by: checkIds } : {}),
      },
    ],
    ...(evaluation.blocking.length > 0 ? { notes: evaluation.blocking.join("; ") } : {}),
  } as unknown as EvidenceRecord["completion"]);
  return { record, evaluation };
}

function unresolvedTool(checkId: string, reason: string | undefined): Diagnostic {
  return diagnostic({
    code: "PAVED_VERIFY_TOOL_UNRESOLVED",
    category: "verification",
    component: "verification.runner",
    message: `Check ${checkId} could not resolve its Tool binding.`,
    ...(reason === undefined ? {} : { remediation: reason }),
  });
}

type MissingEnvironment = { readonly files?: readonly string[]; readonly variables?: readonly string[] };

/** What a Check's `environment.requires` names and is absent from `root` or the process environment. Never reads a file or a value. */
function missingEnvironment(check: CheckContract, root: string, env: NodeJS.ProcessEnv = process.env): MissingEnvironment | undefined {
  const requires = check.environment?.requires;
  if (requires === undefined) return undefined;
  // The schema rejects absolute paths and parent traversal, so each path stays inside root.
  const files = (requires.files ?? []).filter((path) => !existsSync(join(root, path)));
  const variables = (requires.variables ?? []).filter((name) => env[name] === undefined || env[name] === "");
  if (files.length === 0 && variables.length === 0) return undefined;
  return { ...(files.length ? { files } : {}), ...(variables.length ? { variables } : {}) };
}

function describeMissing(missing: MissingEnvironment): string {
  return [
    ...(missing.files?.length ? [`missing file${missing.files.length > 1 ? "s" : ""} ${missing.files.join(", ")}`] : []),
    ...(missing.variables?.length ? [`missing variable${missing.variables.length > 1 ? "s" : ""} ${missing.variables.join(", ")}`] : []),
  ].join("; ");
}

function environmentDiagnostic(checkId: string, missing: MissingEnvironment): Diagnostic {
  return diagnostic({
    code: "PAVED_CHECK_ENVIRONMENT_UNAVAILABLE",
    category: "findings",
    component: "verification.runner",
    message: `Check ${checkId} could not run here: ${describeMissing(missing)}.`,
    remediation: "Provide what is missing in this checkout (Paved never copies it), or run the check where it is available.",
  });
}

/** A Check recorded without running: skipped when the change does not concern it, blocked when it cannot run. */
function notRunCheck(args: {
  check: CheckContract;
  tools: readonly ToolContract[];
  implementations: readonly ToolImplementation[];
  revision: string;
  status: "skipped" | "blocked";
  reason: string;
  extra?: Record<string, unknown>;
}): Awaited<ReturnType<typeof executeCheck>> {
  const resolution = resolveTool(args.check.tool, [...args.tools], [...args.implementations], "local");
  if (resolution.status !== "resolved" || resolution.tool === undefined || resolution.implementation === undefined) {
    return { diagnostic: unresolvedTool(args.check.id, resolution.reason) };
  }
  const now = new Date().toISOString();
  const captured = captureToolExecution({
    tool: resolution.tool, implementation: resolution.implementation, environment: "local", revision: args.revision,
    runtime_version: RUNTIME_VERSION, recorded_by: "paved", started_at: now, finished_at: now,
    status: "blocked", output: "", inputs: args.check.inputs ?? {}, errors: [args.reason],
  });
  const blocked = toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id));
  return { evidenceCheck: { ...blocked, status: args.status, reason: args.reason, ...args.extra } as EvidenceRecord["checks"][number] };
}

async function executeCheck(args: {
  check: CheckContract;
  tools: readonly ToolContract[];
  implementations: readonly ToolImplementation[];
  sourceRoot: string;
  revision: string;
  /** Where the output log is written; the check's own log by default. */
  outputRef?: string;
}): Promise<{
  diagnostic?: Diagnostic;
  evidenceCheck?: EvidenceRecord["checks"][number];
  log?: { relativePath: string; content: string };
}> {
  const resolution = resolveTool(args.check.tool, [...args.tools], [...args.implementations], "local");
  if (resolution.status !== "resolved" || resolution.tool === undefined || resolution.implementation === undefined) {
    return { diagnostic: unresolvedTool(args.check.id, resolution.reason) };
  }

  const missing = missingEnvironment(args.check, args.sourceRoot);
  if (missing !== undefined) {
    // Reported with the other unproven Checks once the record is complete.
    return notRunCheck({
      ...args, status: "blocked", reason: `Environment unavailable: ${describeMissing(missing)}.`, extra: { missing_environment: missing },
    });
  }

  if (args.check.preconditions && args.check.preconditions.length > 0) {
    const now = new Date().toISOString();
    const captured = captureToolExecution({
      tool: resolution.tool,
      implementation: resolution.implementation,
      environment: "local",
      revision: args.revision,
      runtime_version: RUNTIME_VERSION,
      recorded_by: "paved",
      started_at: now,
      finished_at: now,
      status: "blocked",
      error_code: "failed-precondition",
      output: "",
      inputs: args.check.inputs ?? {},
      errors: [`precondition ${args.check.preconditions[0]!.id} is unmet`],
    });
    return { evidenceCheck: toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id)) };
  }

  const validation = validateToolInputs(resolution.tool, args.check.inputs ?? {});
  if (validation.problems.length > 0) {
    return {
      diagnostic: diagnostic({
        code: "PAVED_VERIFY_INPUT_INVALID",
        category: "config",
        component: "verification.runner",
        message: `Check ${args.check.id} supplies invalid Tool inputs.`,
        remediation: validation.problems.join("; "),
      }),
    };
  }

  const sensitiveInputs = sensitiveArgvInputNames(resolution.tool, resolution.implementation, validation.values);
  if (sensitiveInputs.length > 0) {
    const now = new Date().toISOString();
    const captured = captureToolExecution({
      tool: resolution.tool,
      implementation: resolution.implementation,
      environment: "local",
      revision: args.revision,
      runtime_version: RUNTIME_VERSION,
      recorded_by: "paved",
      started_at: now,
      finished_at: now,
      status: "blocked",
      error_code: "policy-violation",
      output: undefined,
      inputs: validation.values,
      errors: ["Sensitive Tool inputs cannot be passed through command argv by the current ToolImplementation contract."],
    });
    return {
      diagnostic: diagnostic({
        code: "PAVED_VERIFY_SENSITIVE_ARGV_INPUT",
        category: "config",
        component: "verification.runner",
        message: `Check ${args.check.id} would expose a sensitive Tool input through its command binding, so it was blocked before execution.`,
        remediation: "Remove the sensitive input binding or introduce a reviewed ToolImplementation contract with an explicit secret channel.",
      }),
      evidenceCheck: toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id)),
    };
  }

  const authorization = authorizeTool(resolution.tool, {
    environment: "local",
    permissions: ["repository-read", "process-read", "process-control"],
    preconditions: Object.fromEntries(resolution.tool.preconditions.map((precondition) => [precondition.id, false])),
  });
  if (!authorization.allowed) {
    const now = new Date().toISOString();
    const captured = captureToolExecution({
      tool: resolution.tool,
      implementation: resolution.implementation,
      environment: "local",
      revision: args.revision,
      runtime_version: RUNTIME_VERSION,
      recorded_by: "paved",
      started_at: now,
      finished_at: now,
      status: "blocked",
      error_code: "failed-precondition",
      output: "",
      inputs: validation.values,
      errors: authorization.reasons,
    });
    return {
      diagnostic: diagnostic({
        code: "PAVED_VERIFY_TOOL_UNAUTHORIZED",
        category: "verification",
        component: "verification.runner",
        message: `Check ${args.check.id} was not authorized to run.`,
        remediation: authorization.reasons.join("; "),
      }),
      evidenceCheck: toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id)),
    };
  }

  const command = buildArgv(resolution.tool, resolution.implementation, validation.values);
  const timeoutSeconds = Math.min(
    args.check.timeout_seconds ?? resolution.tool.timeout_seconds,
    resolution.implementation.invocation.timeout_seconds ?? resolution.tool.timeout_seconds,
    resolution.tool.timeout_seconds,
  );
  const invocation = resolution.implementation.invocation as ToolImplementation["invocation"] & { working_directory?: string };
  const cwd = invocation.working_directory === undefined
    ? args.sourceRoot
    : safe(args.sourceRoot, invocation.working_directory);
  const started = new Date().toISOString();
  const requiredVariables = args.check.environment?.requires?.variables ?? [];
  const execution = await spawnApproved({ executable: command.executable, argv: command.argv, cwd, timeoutSeconds, requiredVariables });
  const finished = new Date().toISOString();
  const secretValues = [
    ...resolution.tool.inputs
      .filter((input) => input.sensitive)
      .map((input) => validation.values[input.name]),
    // Declared variables reach the process, so their values never reach the record. Very short
    // values (a flag such as 1) are left alone: scrubbing them would garble the whole log.
    ...requiredVariables.map((name) => process.env[name]).filter((value) => value !== undefined && value.length >= 4),
  ].filter((value): value is string => typeof value === "string" && value !== "");
  const sanitizedOutput = [
    `stdout:\n${sanitizeToolOutput(execution.stdout, secretValues) as string}`,
    `stderr:\n${sanitizeToolOutput(execution.stderr, secretValues) as string}`,
  ].join("\n");

  if (execution.kind === "launch-error") {
    return {
      diagnostic: diagnostic({
        code: "PAVED_VERIFY_LAUNCH_FAILED",
        category: "environment",
        component: "verification.runner",
        message: `Check ${args.check.id} could not start its configured executable.`,
        remediation: "Ensure the selected ToolImplementation executable is installed and executable.",
      }),
    };
  }

  const parsed = parseToolOutput(resolution.tool, execution.stdout);
  const malformedOutputProblems = execution.kind === "completed"
    ? [...parsed.problems, ...validateToolResult(resolution.tool, sanitizeToolOutput(parsed.output, secretValues))]
    : [];
  const malformedOutput = malformedOutputProblems.length > 0;
  const stderr = stderrMessages(execution.stderr, secretValues);
  const commandFailed = execution.kind === "completed" && execution.exitCode !== undefined && execution.exitCode !== 0;
  const captured = captureToolExecution({
    tool: resolution.tool,
    implementation: resolution.implementation,
    environment: "local",
    revision: args.revision,
    runtime_version: RUNTIME_VERSION,
    recorded_by: "paved",
    started_at: started,
    finished_at: finished,
    status: execution.kind === "timeout" ? "timed-out" : malformedOutput ? "failed" : "succeeded",
    ...(execution.exitCode === undefined || malformedOutput ? {} : { exit_code: execution.exitCode }),
    ...(execution.kind === "timeout" ? { error_code: "timeout" as const } : {}),
    ...(malformedOutput ? { error_code: "malformed-output" as const } : {}),
    output: parsed.output,
    inputs: validation.values,
    warnings: [
      ...(execution.truncated ? ["Verification output was truncated."] : []),
      ...(!commandFailed ? stderr.warnings : []),
    ],
    errors: [
      ...(execution.kind === "timeout" ? ["Verification command timed out."] : []),
      ...malformedOutputProblems,
      ...(commandFailed ? stderr.errors : []),
    ],
  });
  const evidenceCheck = toEvidenceCheck(captured, args.check, evidenceCheckId(args.check.id));
  const outputRef = args.outputRef ?? `.paved/generated/evidence/${evidenceCheck.id}.log`;
  (evidenceCheck as EvidenceRecord["checks"][number] & { output_ref: string }).output_ref = outputRef;
  return {
    ...(malformedOutput ? {
      diagnostic: diagnostic({
        code: "PAVED_VERIFY_OUTPUT_MALFORMED",
        category: "verification",
        component: "verification.runner",
        message: `Check ${args.check.id} produced malformed Tool output.`,
        remediation: malformedOutputProblems.join("; "),
      }),
    } : {}),
    evidenceCheck,
    log: { relativePath: outputRef, content: sanitizedOutput },
  };
}

function writeValidatedEvidence(args: {
  projectRoot: string;
  coreRoot: string;
  record: EvidenceRecord;
  logs: readonly { relativePath: string; content: string }[];
  definitions: ReadonlyMap<string, CheckDefinition>;
  policy?: VerificationPolicy;
  diagnostics: Diagnostic[];
}): string[] {
  const schemaRegistry = registry(args.coreRoot);
  const registryData = loadEvidenceRegistry(join(args.coreRoot, "core/verification/registry.yaml"));
  const schemaValidation = schemaRegistry.validate(args.record);
  const assessment = schemaValidation.valid
    ? assessEvidence(args.record, registryData, args.policy ?? {}, args.definitions)
    : [];
  if (!schemaValidation.valid || assessment.length > 0) {
    args.diagnostics.push(diagnostic({
      code: "PAVED_VERIFY_EVIDENCE_INVALID",
      category: "verification",
      component: "verification.evidence",
      message: "Verification evidence could not be validated.",
      remediation: [...schemaValidation.errors, ...assessment].join("; "),
    }));
    return [];
  }

  const evidenceDir = safe(args.projectRoot, ".paved/generated/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  for (const log of args.logs) {
    const target = safe(args.projectRoot, log.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    atomicWriteFileSync(target, log.content);
  }
  const evidenceFile = join(evidenceDir, `${(args.record as EvidenceRecord & { id: string }).id}.yaml`);
  atomicWriteFileSync(evidenceFile, stringify(args.record));
  return [evidenceFile];
}

// Records are named by creation time, so the newest few are enough to find the latest run for a tree.
const REUSE_SCAN_LIMIT = 20;

type CheckRecord = EvidenceRecord["checks"][number] & {
  output_ref?: string;
  definition_sha256?: string;
  missing_environment?: MissingEnvironment;
  blocked_by?: string[];
  pre_existing?: boolean;
  baseline?: Baseline;
};

interface Baseline {
  revision: string;
  status: string;
  exit_code?: number;
  output_ref?: string;
  output_sha256?: string;
  reused_from?: string;
}

type StoredRecord = EvidenceRecord & {
  id: string;
  created_at: string;
  verification?: { profile_sha256?: string; configuration_sha256?: string; base_revision?: string };
  change: EvidenceRecord["change"] & { tree_id?: string };
  checks: CheckRecord[];
};

type ArtifactSource = { source?: { location?: string; sha256?: string } };

/** The newest evidence records, newest first; unreadable ones are left out. */
function recentRecords(projectRoot: string): { file: string; record: StoredRecord }[] {
  const evidenceDir = safe(projectRoot, ".paved/generated/evidence");
  let names: string[];
  try {
    names = readdirSync(evidenceDir).filter((name) => /^verify-[a-z0-9-]+\.yaml$/.test(name)).sort().reverse().slice(0, REUSE_SCAN_LIMIT);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(evidenceDir, name);
    try {
      if (!lstatSync(file).isFile()) return [];
      const record = parseYaml(readFileSync(file, "utf8")) as StoredRecord;
      return record !== null && typeof record === "object" && Array.isArray(record.checks) ? [{ file, record }] : [];
    } catch {
      return [];
    }
  });
}

function readLog(projectRoot: string, outputRef: string): string | undefined {
  try {
    const path = safe(projectRoot, outputRef);
    return lstatSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks that did not pass for a reason outside the change: a pre-existing failure, an
 * unavailable environment, or a dependency blocked for one of those reasons. Everything
 * else that did not pass or skip is `other`.
 */
function classifyUnproven(checks: readonly CheckRecord[]): { unproven: UnprovenCheck[]; other: CheckRecord[] } {
  const reasons = new Map<string, UnprovenReason>();
  const unproven: UnprovenCheck[] = [];
  const other: CheckRecord[] = [];
  for (const check of checks) {
    if (check.status === "passed" || check.status === "skipped") continue;
    const reason: UnprovenReason | undefined = check.status === "failed" && check.pre_existing === true ? "pre-existing"
      : check.status === "blocked" && check.missing_environment !== undefined ? "environment-unavailable"
        : check.status === "blocked" && check.blocked_by?.length && check.blocked_by.every((id) => reasons.has(id)) ? "dependency-unproven"
          : undefined;
    if (reason === undefined) {
      other.push(check);
      continue;
    }
    reasons.set(check.check, reason);
    unproven.push({
      id: check.check, status: check.status, reason,
      ...(check.output_ref === undefined ? {} : { output_ref: check.output_ref }),
      ...(check.baseline?.output_ref === undefined ? {} : { base_output_ref: check.baseline.output_ref }),
      ...(check.missing_environment === undefined ? {} : { missing: check.missing_environment }),
      ...(check.blocked_by === undefined ? {} : { blocked_by: check.blocked_by }),
    });
  }
  return { unproven, other };
}

/**
 * The unproven Checks when they are the record's only problems, so that verification is a
 * `warning` rather than a failure: every other Check passed or was skipped, and the record
 * without the unproven Checks is complete and verified.
 */
function warningVerdict(record: StoredRecord, registryData: ReturnType<typeof loadEvidenceRegistry>, policy: VerificationPolicy, definitions: ReadonlyMap<string, CheckDefinition>): UnprovenCheck[] | undefined {
  const { unproven, other } = classifyUnproven(record.checks);
  if (unproven.length === 0 || other.length > 0) return undefined;
  const excluded = new Set(unproven.map((item) => item.id));
  const remaining = record.checks.filter((check) => !excluded.has(check.check));
  const passed = remaining.filter((check) => check.status === "passed").map((check) => check.id);
  if (passed.length === 0) return unproven;
  const ids = new Set(remaining.map((check) => check.id));
  const reduced = {
    ...record,
    checks: remaining,
    plan: { ...record.plan, required: [...new Set(remaining.filter((check) => check.status === "passed").map((check) => check.type))].sort() },
    claims: record.claims.map((claim) => ({ ...claim, supported_by: claim.supported_by.filter((ref) => ids.has(ref) || !record.checks.some((check) => check.id === ref)) })),
    completion: { ...record.completion, criteria: [{ met: true, supported_by: passed }] },
  } as StoredRecord;
  const evaluation = evaluateCompletion(reduced, registryData, policy, definitions);
  return evaluation.status === "complete" && evaluation.verification === "verified" ? unproven : undefined;
}

function unprovenDiagnostics(unproven: readonly UnprovenCheck[], baseRevision: string | undefined): Diagnostic[] {
  return unproven.map((item) => {
    if (item.reason === "environment-unavailable") return environmentDiagnostic(item.id, item.missing ?? {});
    if (item.reason === "pre-existing") {
      return diagnostic({
        code: "PAVED_VERIFY_PRE_EXISTING_FAILURE",
        category: "findings",
        component: "verification.runner",
        message: `Check ${item.id} fails the same way on the base revision ${baseRevision?.slice(0, 12) ?? "(unknown)"}; the change did not introduce this failure.`,
        remediation: `It still does not pass. Compare ${item.output_ref ?? "the head output"} with ${item.base_output_ref ?? "the base output"} and fix it separately.`,
      });
    }
    return diagnostic({
      code: "PAVED_VERIFY_DEPENDENCY_UNPROVEN",
      category: "findings",
      component: "verification.runner",
      message: `Check ${item.id} did not run because ${item.blocked_by?.join(", ") ?? "a dependency"} could not be proven here.`,
    });
  });
}

function incompleteDiagnostic(evaluation: ReturnType<typeof evaluateCompletion>): Diagnostic {
  return diagnostic({
    code: "PAVED_VERIFY_INCOMPLETE",
    category: "verification",
    component: "verification.evidence",
    message: "Configured verification did not complete successfully.",
    remediation: [...evaluation.blocking, ...evaluation.warnings].join("; "),
  });
}

/** What a caller needs to act on each Check: its output, why it did not run, and a short failure excerpt. */
function checkSummaries(projectRoot: string, checks: readonly CheckRecord[]): CheckSummary[] {
  return checks.map((check) => {
    const failing = check.status === "failed" || check.status === "error";
    const log = failing && check.output_ref !== undefined ? readLog(projectRoot, check.output_ref) : undefined;
    const excerpt = log === undefined ? [] : failureExcerpt(log);
    return {
      id: check.check, status: check.status, type: check.type,
      ...(check.output_ref === undefined ? {} : { output_ref: check.output_ref }),
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      ...(excerpt.length > 0 ? { excerpt } : {}),
      ...(check.pre_existing === true ? { pre_existing: true as const } : {}),
      ...(check.baseline?.output_ref === undefined ? {} : { base_output_ref: check.baseline.output_ref }),
    };
  });
}

function sameChange(record: StoredRecord, change: WorktreeFingerprint, treeId: string | undefined): boolean {
  const exact = record.change?.revision === change.revision &&
    (record.change.uncommitted_changes === true) === change.uncommitted &&
    record.change.worktree_sha256 === change.worktreeSha;
  return exact || (treeId !== undefined && record.change?.tree_id === treeId);
}

/**
 * The newest record made for exactly this content and configuration, when it can stand
 * for a new run: a verified record always; a warning record when it compared failures with
 * the same base; and, after waiting for another run's lock, whatever that run recorded.
 * The newest matching record decides, so a later failure is never hidden by an earlier pass.
 * The content matches by working tree fingerprint, or by tree id, so a record made before a
 * commit also serves the commit that captures exactly that tree.
 */
function reusableVerification(args: {
  projectRoot: string;
  coreRoot: string;
  change: WorktreeFingerprint;
  treeId?: string;
  profileSha: string;
  configurationSha: string;
  baseRevision?: string;
  checks: readonly CheckContract[];
  policy?: VerificationPolicy;
  diagnostics: readonly Diagnostic[];
  recordedSince?: number;
}): VerificationRunResult | undefined {
  for (const { file, record } of recentRecords(args.projectRoot)) {
    if (record.verification?.configuration_sha256 !== args.configurationSha ||
      record.verification.profile_sha256 !== args.profileSha) continue;
    if (!sameChange(record, args.change, args.treeId)) continue;

    const definitions = new Map(args.checks.map((check) => [check.id, check]));
    const registryData = loadEvidenceRegistry(join(args.coreRoot, "core/verification/registry.yaml"));
    if (!registry(args.coreRoot).validate(record).valid ||
      assessEvidence(record, registryData, args.policy ?? {}, definitions).length > 0) return undefined;
    const evaluation = evaluateCompletion(record, registryData, args.policy ?? {}, definitions);
    const reused = { evidenceFiles: [file], evidence: record, evaluation, checks: checkSummaries(args.projectRoot, record.checks), reused: true } as const;
    if (record.completion?.status === "complete" && evaluation.status === "complete" && evaluation.verification === "verified") {
      return { status: "success", diagnostics: args.diagnostics, ...reused };
    }
    if (record.verification.base_revision !== args.baseRevision) return undefined;
    const { unproven } = classifyUnproven(record.checks);
    const warning = warningVerdict(record, registryData, args.policy ?? {}, definitions);
    if (warning !== undefined) {
      return { status: "warning", diagnostics: [...args.diagnostics, ...unprovenDiagnostics(warning, args.baseRevision)], unproven: warning, ...reused };
    }
    if (args.recordedSince !== undefined && Date.parse(record.created_at) >= args.recordedSince) {
      return {
        status: "failed",
        diagnostics: [...args.diagnostics, ...unprovenDiagnostics(unproven, args.baseRevision), incompleteDiagnostic(evaluation)],
        ...(unproven.length > 0 ? { unproven } : {}),
        ...reused,
      };
    }
    return undefined;
  }
  return undefined;
}

/** The base outcome of a Check recorded by an earlier run, when its output is still intact. */
function recordedBaseline(projectRoot: string, checkId: string, definitionSha: string, baseRevision: string): (Baseline & { output: string }) | undefined {
  for (const { record } of recentRecords(projectRoot)) {
    for (const check of record.checks) {
      if (check.check !== checkId || check.definition_sha256 !== definitionSha) continue;
      const baseline = check.baseline;
      if (baseline?.revision === baseRevision && (baseline.status === "passed" || baseline.status === "failed") &&
        baseline.output_ref !== undefined && baseline.output_sha256 !== undefined) {
        const output = readLog(projectRoot, baseline.output_ref);
        if (output !== undefined && sha(output) === baseline.output_sha256) {
          const { reused_from: _earlier, ...kept } = baseline;
          return { ...kept, reused_from: record.id, output };
        }
      }
      // A run on the base commit itself is the base outcome.
      if (record.change?.revision === baseRevision && record.change.uncommitted_changes !== true &&
        (check.status === "passed" || check.status === "failed") && check.output_ref !== undefined) {
        const output = readLog(projectRoot, check.output_ref);
        const artifact = (record.artifacts as ArtifactSource[] | undefined)?.find((item) => item.source?.location === check.output_ref);
        if (output !== undefined && artifact?.source?.sha256 === sha(output)) {
          return {
            revision: baseRevision, status: check.status, ...(check.exit_code === undefined ? {} : { exit_code: check.exit_code }),
            output_ref: check.output_ref, output_sha256: sha(output), reused_from: record.id, output,
          };
        }
      }
    }
  }
  return undefined;
}

/**
 * Compares each failed Check with the same Check on the base revision and marks the
 * failure `pre_existing` when the base fails the same way. Only failed Checks run there,
 * each within its own timeout, in a temporary worktree removed afterwards; a base outcome
 * an earlier run recorded for the same Check is reused instead. Returns the base logs.
 */
async function classifyFailures(args: {
  projectRoot: string;
  sourceRoot: string;
  baseRevision: string;
  change: WorktreeFingerprint;
  checks: readonly CheckContract[];
  tools: readonly ToolContract[];
  implementations: readonly ToolImplementation[];
  evidenceChecks: CheckRecord[];
  logs: ReadonlyMap<string, string>;
}): Promise<{ relativePath: string; content: string }[]> {
  const failed = args.evidenceChecks.filter((check) => check.status === "failed" && check.exit_code !== undefined && check.output_ref !== undefined);
  if (failed.length === 0) return [];
  const definitions = new Map(args.checks.map((check) => [check.id, check]));
  const baselines = new Map<string, Baseline & { output: string }>();
  const baseLogs: { relativePath: string; content: string }[] = [];

  if (!args.change.uncommitted && args.change.revision === args.baseRevision) {
    // Nothing changed since the base: what failed here failed there.
    for (const check of failed) {
      const output = args.logs.get(check.output_ref!) ?? "";
      baselines.set(check.check, { revision: args.baseRevision, status: check.status, exit_code: check.exit_code!, output_ref: check.output_ref!, output_sha256: sha(output), output });
    }
  } else {
    const pending: CheckContract[] = [];
    for (const check of failed) {
      const recorded = check.definition_sha256 === undefined ? undefined : recordedBaseline(args.projectRoot, check.check, check.definition_sha256, args.baseRevision);
      if (recorded !== undefined) baselines.set(check.check, recorded);
      else pending.push(definitions.get(check.check)!);
    }
    if (pending.length > 0) {
      await withBaseWorktree(args.sourceRoot, args.baseRevision, async (baseRoot) => {
        const roots = [...new Set([baseRoot, realpathSync(baseRoot)])];
        for (const check of pending) {
          const outputRef = `.paved/generated/evidence/${evidenceCheckId(check.id)}-base.log`;
          const run = await executeCheck({ check, tools: args.tools, implementations: args.implementations, sourceRoot: baseRoot, revision: args.baseRevision, outputRef });
          const status = run.evidenceCheck?.status;
          if (status === undefined || status === "skipped") continue;
          const content = run.log === undefined ? undefined : roots.reduce((text, root) => text.split(root).join(ROOT_PLACEHOLDER), run.log.content);
          if (content !== undefined) baseLogs.push({ relativePath: outputRef, content });
          baselines.set(check.id, {
            revision: args.baseRevision, status,
            ...(run.evidenceCheck?.exit_code === undefined ? {} : { exit_code: run.evidenceCheck.exit_code }),
            ...(content === undefined ? {} : { output_ref: outputRef, output_sha256: sha(content) }),
            output: content ?? "",
          });
        }
      });
    }
  }

  const roots = [...new Set([args.sourceRoot, realpathSync(args.sourceRoot)])];
  for (const check of failed) {
    const baseline = baselines.get(check.check);
    if (baseline === undefined) continue;
    const { output, ...recorded } = baseline;
    check.baseline = recorded;
    const head = { status: check.status, exit_code: check.exit_code!, output: args.logs.get(check.output_ref!) ?? "" };
    if (isPreExisting(head, { status: baseline.status, ...(baseline.exit_code === undefined ? {} : { exit_code: baseline.exit_code }), output }, roots)) {
      check.pre_existing = true;
    }
  }
  return baseLogs;
}

interface ResolvedVerification {
  readonly profile: VerificationProfile;
  readonly profilePath: string;
  readonly checks: CheckContract[];
  readonly tools: ToolContract[];
  readonly implementations: ToolImplementation[];
  readonly diagnostics: Diagnostic[];
}

/** Loads and validates the profile and everything it references, without running anything. */
function resolveVerification(input: VerificationRunInput): ResolvedVerification | VerificationRunResult {
  const diagnostics: Diagnostic[] = [];
  const schemaRegistry = registry(input.coreRoot);
  const profilePath = safe(input.projectRoot, ".paved/verification/profile.yaml");
  if (!existsSync(profilePath)) {
    return {
      status: "failed",
      checks: [],
      evidenceFiles: [],
      diagnostics: [
        diagnostic({
          code: "PAVED_VERIFY_PROFILE_MISSING",
          category: "verification",
          component: "verification.profile",
          message: ".paved/verification/profile.yaml is missing; no verification checks are authorized.",
          remediation: "Create an explicit verification profile or record the verification gap.",
        }),
      ],
    };
  }

  const profile = validateDocument<VerificationProfile>(schemaRegistry, profilePath, "VerificationProfile", diagnostics);
  if (profile === undefined) {
    return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
  }
  if (profile.checks.length === 0) {
    return {
      status: "failed",
      checks: [],
      evidenceFiles: [],
      diagnostics: [
        diagnostic({
          code: "PAVED_VERIFY_NO_CHECKS",
          category: "verification",
          component: "verification.profile",
          message: "The verification profile lists no checks, so nothing can be verified.",
          remediation: "Add explicit Check ids to .paved/verification/profile.yaml or record a gap.",
        }),
      ],
    };
  }

  const roots = contentRoots(input);
  const listed = profile.checks
    .map((id) => {
      const check = findDocument<CheckContract>(roots.checks, id, "Check", schemaRegistry, diagnostics);
      if (check === undefined && !diagnostics.some((item) => item.message.includes(id))) {
        diagnostics.push(diagnostic({
          code: "PAVED_VERIFY_CHECK_UNRESOLVED",
          category: "verification",
          component: "verification.config",
          message: `Check ${id} is listed in the verification profile but no selected Check document defines it.`,
        }));
      }
      return check;
    })
    .filter((check): check is CheckContract => check !== undefined);

  if (diagnostics.some((item) => item.category === "config")) {
    return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
  }
  if (listed.length !== profile.checks.length) {
    return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
  }
  const order = orderChecks(listed);
  if (!("ordered" in order)) {
    diagnostics.push("cycle" in order
      ? diagnostic({
        code: "PAVED_VERIFY_CHECK_DEPENDENCY_CYCLE",
        category: "config",
        component: "verification.config",
        message: `Check dependencies form a cycle: ${order.cycle.join(" -> ")}.`,
        remediation: "Remove one depends_on entry of the cycle so every check can run after the checks it needs.",
      })
      : diagnostic({
        code: "PAVED_VERIFY_CHECK_DEPENDENCY_UNRESOLVED",
        category: "config",
        component: "verification.config",
        message: order.unresolved.map(({ check, dependency }) => `Check ${check} depends on ${dependency}, which the verification profile does not list.`).join(" "),
        remediation: "List every dependency in .paved/verification/profile.yaml or remove it from depends_on.",
      }));
    return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
  }
  const checks = order.ordered;

  const tools: ToolContract[] = [];
  const implementations: ToolImplementation[] = [];
  for (const toolId of [...new Set(checks.map((check) => check.tool))]) {
    const tool = findDocument<ToolContract>(roots.tools, toolId, "Tool", schemaRegistry, diagnostics);
    if (tool === undefined) {
      diagnostics.push(diagnostic({
        code: "PAVED_VERIFY_TOOL_UNRESOLVED",
        category: "verification",
        component: "verification.config",
        message: `Tool ${toolId} is required by a configured Check but is not available in selected Paved content roots.`,
      }));
      continue;
    }
    const toolProblems = validateTool(tool);
    if (toolProblems.length > 0) {
      diagnostics.push(diagnostic({
        code: "PAVED_VERIFY_TOOL_INVALID",
        category: "config",
        component: "verification.config",
        message: `Tool ${toolId} is invalid.`,
        remediation: toolProblems.join("; "),
      }));
    }
    tools.push(tool);
    const candidates = findImplementations(roots.implementations, toolId, schemaRegistry, diagnostics);
    for (const implementation of candidates) {
      const problems = validateImplementation(implementation, tool);
      if (problems.length > 0) {
        diagnostics.push(diagnostic({
          code: "PAVED_VERIFY_IMPLEMENTATION_INVALID",
          category: "config",
          component: "verification.config",
          message: `ToolImplementation ${implementation.id} is invalid for Tool ${toolId}.`,
          remediation: problems.join("; "),
        }));
      }
    }
    implementations.push(...candidates);
  }

  if (diagnostics.some((item) => item.category === "config")) {
    return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
  }
  if (diagnostics.some((item) => item.code === "PAVED_VERIFY_TOOL_UNRESOLVED")) {
    return { status: "failed", checks: [], evidenceFiles: [], diagnostics };
  }
  return { profile, profilePath, checks, tools, implementations, diagnostics };
}

/** Configuration problems `paved verify` would hit, reported before anything runs. */
export function inspectVerificationConfig(input: VerificationRunInput): Diagnostic[] {
  if (!existsSync(safe(input.projectRoot, ".paved/verification/profile.yaml"))) return [];
  const resolved = resolveVerification(input);
  return resolved.diagnostics.filter((item) => item.code !== "PAVED_VERIFY_NO_CHECKS");
}

/** Which of a Check's declared environment entries are present: names and booleans only. */
function environmentPresence(checks: readonly CheckContract[], sourceRoot: string): Record<string, MissingEnvironment> {
  return Object.fromEntries(checks.flatMap((check) => {
    const missing = missingEnvironment(check, sourceRoot);
    return missing === undefined ? [] : [[check.id, missing]];
  }));
}

async function runVerificationUnlocked(input: VerificationRunInput, recordedSince?: number): Promise<VerificationRunResult> {
  const resolved = resolveVerification(input);
  if (!("profilePath" in resolved)) return resolved;
  const { profile, profilePath, checks, tools, implementations, diagnostics } = resolved;

  const sourceRoot = input.sourceRoot ?? input.projectRoot;
  const fingerprintFailure = (message: string): VerificationRunResult => ({
    status: "failed", checks: [], evidenceFiles: [], diagnostics: [...diagnostics, diagnostic({
      code: "PAVED_VERIFY_CHANGE_UNPROVEN", category: "verification", component: "verification.evidence",
      message, remediation: "Restore a readable, stable working tree and run verification again.",
    })],
  });
  let change: WorktreeFingerprint;
  try {
    change = fingerprintWorktree(sourceRoot);
  } catch {
    return fingerprintFailure("Cannot fingerprint the working tree before verification.");
  }
  const treeId = change.revision === "unversioned" ? undefined : contentTreeId(sourceRoot);
  const revision = change.revision;
  const profileSha = sha(readFileSync(profilePath));
  const relevant = checks.filter((check) => irrelevance(check, input.changedFiles) === undefined);
  const definitionSha = new Map(checks.map((check) => [check.id, sha(JSON.stringify({
    check,
    tool: tools.find((tool) => tool.id === check.tool) ?? null,
    implementations: implementations.filter((implementation) => implementation.tool === check.tool),
  }))]));
  // Anything that can change which Checks run, or how, is part of the configuration a record is reused for.
  const configurationSha = sha(JSON.stringify({
    checks,
    tools,
    implementations,
    selected: relevant.map((check) => check.id),
    environment: environmentPresence(relevant, sourceRoot),
  }));
  const policy = profile.policy === undefined ? {} : { policy: profile.policy };
  const reused = reusableVerification({
    projectRoot: input.projectRoot,
    coreRoot: input.coreRoot,
    change,
    ...(treeId === undefined ? {} : { treeId }),
    profileSha,
    configurationSha,
    ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
    checks,
    ...policy,
    diagnostics,
    ...(input.recordedOnly ? { recordedSince: 0 } : recordedSince === undefined ? {} : { recordedSince }),
  });
  if (reused !== undefined) return reused;
  if (input.recordedOnly && relevant.length > 0) {
    return {
      status: "failed", checks: [], evidenceFiles: [], diagnostics: [...diagnostics, diagnostic({
        code: "PAVED_VERIFY_NOT_RECORDED", category: "verification", component: "verification.evidence",
        message: "No verification is recorded for the current change and configuration; no Check was run.",
        remediation: "Run paved verify (with the same --changed and --base scope) to verify the change.",
      })],
    };
  }
  // Resolve the complete set first: an ask or deny on a later Check must not partially run verification.
  input.beforeRun?.(relevant.flatMap((check) => {
    const selected = resolveTool(check.tool, tools, implementations, "local");
    return selected.status === "resolved" && selected.tool && selected.implementation
      ? [{ tool: selected.tool, implementation: selected.implementation, inputs: check.inputs ?? {} }] : [];
  }));
  const evidenceChecks: CheckRecord[] = [];
  const logs: { relativePath: string; content: string }[] = [];
  const outcomes = new Map<string, string>();
  for (const check of checks) {
    const skipped = irrelevance(check, input.changedFiles);
    const unmet = (check.depends_on ?? []).filter((id) => !["passed", "skipped"].includes(outcomes.get(id) ?? "error"));
    const result = skipped !== undefined
      ? notRunCheck({ check, tools, implementations, revision, status: "skipped", reason: skipped })
      : unmet.length > 0
        ? notRunCheck({
          check, tools, implementations, revision, status: "blocked", extra: { blocked_by: unmet },
          reason: `Not run on stale inputs: ${unmet.map((id) => `${id} is ${outcomes.get(id) ?? "error"}`).join(", ")}.`,
        })
        : await executeCheck({ check, tools, implementations, sourceRoot, revision });
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (result.evidenceCheck) evidenceChecks.push({ ...result.evidenceCheck, definition_sha256: definitionSha.get(check.id)! });
    if (result.log) logs.push(result.log);
    outcomes.set(check.id, result.evidenceCheck?.status ?? "error");
  }

  try {
    const after = fingerprintWorktree(sourceRoot);
    if (after.revision !== change.revision || after.uncommitted !== change.uncommitted || after.worktreeSha !== change.worktreeSha) {
      return fingerprintFailure("The working tree changed during verification.");
    }
  } catch {
    return fingerprintFailure("Cannot fingerprint the working tree after verification.");
  }

  const baseLogs = input.baseRevision === undefined ? [] : await classifyFailures({
    projectRoot: input.projectRoot, sourceRoot, baseRevision: input.baseRevision, change, checks, tools, implementations,
    evidenceChecks, logs: new Map(logs.map((log) => [log.relativePath, log.content])),
  });

  const built = buildEvidence({
    projectRoot: input.projectRoot,
    sourceRoot,
    coreRoot: input.coreRoot,
    profilePath,
    profileSha,
    configurationSha,
    ...policy,
    checks,
    evidenceChecks,
    outputLogs: logs,
    change,
    ...(treeId === undefined ? {} : { treeId }),
    ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
  });
  const definitions = new Map(checks.map((check) => [check.id, check]));
  const evidenceFiles = writeValidatedEvidence({
    projectRoot: input.projectRoot,
    coreRoot: input.coreRoot,
    record: built.record,
    logs: [...logs, ...baseLogs],
    definitions,
    ...policy,
    diagnostics,
  });

  const record = built.record as unknown as StoredRecord;
  const { unproven } = classifyUnproven(record.checks);
  diagnostics.push(...unprovenDiagnostics(unproven, input.baseRevision));
  const blocking = built.evaluation.status !== "complete" || built.evaluation.verification !== "verified";
  const registryData = loadEvidenceRegistry(join(input.coreRoot, "core/verification/registry.yaml"));
  const warning = blocking && !diagnostics.some((item) => item.category !== "findings") &&
    warningVerdict(record, registryData, profile.policy ?? {}, definitions) !== undefined;
  if (blocking && !warning) diagnostics.push(incompleteDiagnostic(built.evaluation));

  return {
    status: diagnostics.some((item) => item.category !== "findings") ? "failed" : warning ? "warning" : "success",
    diagnostics,
    evidenceFiles,
    evidence: built.record,
    evaluation: built.evaluation,
    checks: checkSummaries(input.projectRoot, record.checks),
    ...(unproven.length > 0 ? { unproven } : {}),
  };
}

const LOCK_POLL_MS = 500;
const WAITABLE_LOCKS = new Set(["running", "acquiring", "reclaiming"]);

/**
 * Runs the configured Checks under the operation lock. With `lockWaitMs`, a lock held by a
 * running operation is waited for; when that operation recorded a run for this same change
 * and configuration, its record is returned instead of running the Checks again.
 */
export async function runVerification(input: VerificationRunInput): Promise<VerificationRunResult> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, input.lockWaitMs ?? 0);
  let waited = false;
  let release: () => void;
  for (;;) {
    try {
      release = acquireConsumerOperationLock(input.projectRoot, "verify");
      break;
    } catch (error) {
      if (!(error instanceof ConsumerOperationLockedError) || !WAITABLE_LOCKS.has(error.reason) || Date.now() >= deadline) throw error;
      waited = true;
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now()))));
    }
  }
  try {
    return await runVerificationUnlocked(input, waited ? startedAt : undefined);
  } finally {
    release();
  }
}
