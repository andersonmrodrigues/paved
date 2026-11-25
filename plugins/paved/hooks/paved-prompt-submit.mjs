import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function nearestRepository(cwd) {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    if (existsSync(join(current, ".paved", "manifest.yaml")) || existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

function stateRepository(repository) {
  if (existsSync(join(repository, ".paved", "manifest.yaml"))) return repository;
  try {
    const dotGit = join(repository, ".git");
    if (!lstatSync(dotGit).isFile()) return repository;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
    if (!pointer) return repository;
    const gitDir = resolve(repository, pointer);
    const common = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
    if (common.split(sep).at(-1) !== ".git") return repository;
    const main = dirname(common);
    return existsSync(join(main, ".paved", "manifest.yaml")) ? main : repository;
  } catch { return repository; }
}

const MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 2000;
const STDIN_TIMEOUT_MS = 5000;

// Never bootstrap a missing selection implicitly from a lifecycle hook.
function launcherFor(repository) {
  if (!existsSync(join(repository, ".paved", "paved.lock")) ||
      !existsSync(join(repository, ".paved", "runtime", "selection.json"))) return undefined;
  const launcher = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "paved.mjs");
  return existsSync(launcher) ? launcher : undefined;
}

// The launcher runs the runtime as a child that shares its stdout, so a timeout must stop the
// whole process group: killing only the launcher would leave the runtime holding the operation
// lock and the pipe this hook waits on. The result settles at the deadline plus a short grace
// even if some process keeps the pipe open, so the hook always returns within its budget.
function runLauncher(launcher, sourceRoot, args, timeout) {
  return new Promise((resolveRun) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      resolveRun(outcome);
    };
    const child = spawn(process.execPath, [launcher, ...args, "--json", "--project", sourceRoot], {
      cwd: sourceRoot, shell: false, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32",
    });
    child.stdout.on("data", (chunk) => {
      if (bytes < MAX_OUTPUT_BYTES) chunks.push(chunk);
      bytes += chunk.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, "SIGTERM");
      setTimeout(() => {
        signalGroup(child, "SIGKILL");
        settle({ kind: "timeout" });
      }, KILL_GRACE_MS);
    }, timeout);
    child.on("error", () => settle({ kind: "unavailable" }));
    child.on("close", (code) => {
      if (timedOut) return settle({ kind: "timeout" });
      let result;
      try { result = bytes <= MAX_OUTPUT_BYTES ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; } catch { result = undefined; }
      settle({ kind: "completed", code, result });
    });
  });
}

async function invoke(repository, sourceRoot, args, timeout, allowedStatuses = [0, 1]) {
  const launcher = launcherFor(repository);
  if (!launcher) return undefined;
  const outcome = await runLauncher(launcher, sourceRoot, args, timeout);
  return outcome.kind === "completed" && allowedStatuses.includes(outcome.code) ? outcome.result : undefined;
}

// Stop only reads the recorded verification for the current change; Checks never run inside the
// hook, so a turn ends in seconds however slow the suite is. The host allows 30 s.
const STOP_TIMEOUT_MS = 20000;

function stopTimeout() {
  // Lowering the budget is allowed (tests, slow hosts); raising it past the host's hook timeout is not.
  const requested = Number(process.env.PAVED_HOOK_VERIFY_TIMEOUT_MS);
  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, STOP_TIMEOUT_MS) : STOP_TIMEOUT_MS;
}

function signalGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The group already exited.
  }
}

function git(sourceRoot, args) {
  const child = spawnSync("git", args, { cwd: sourceRoot, encoding: "utf8", timeout: 5000, shell: false, env: { ...process.env, LC_ALL: "C" } });
  return child.error || child.status !== 0 ? undefined : child.stdout.trim();
}

// The branch this work will merge into: the remote's default branch, else a local or remote
// main or master. A committed change is then still compared with where it started.
function defaultBase(sourceRoot) {
  const remoteDefault = git(sourceRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [remoteDefault, "main", "master", "origin/main", "origin/master"].filter(Boolean);
  for (const ref of candidates) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) continue;
    if (git(sourceRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) && git(sourceRoot, ["merge-base", "HEAD", ref])) return ref;
  }
  return undefined;
}

function verifyCommand(base) {
  return `paved verify --changed${base ? ` --base ${base}` : ""}`;
}

function hasCode(result, code) {
  return Array.isArray(result?.diagnostics) && result.diagnostics.some((item) => item?.code === code);
}

function verificationFailure(outcome, timeout, base) {
  const command = verifyCommand(base);
  if (outcome.kind === "timeout") {
    return `NOT VERIFIED: Paved could not read the recorded verification within the ${Math.round(timeout / 1000)} s Stop hook budget. ` +
      `Run \`${command}\` directly; its result for the same working tree is reused at the next Stop.`;
  }
  const diagnostics = Array.isArray(outcome.result?.diagnostics) ? outcome.result.diagnostics : [];
  if (outcome.result?.command === "verify" && hasCode(outcome.result, "PAVED_VERIFY_NOT_RECORDED")) {
    return `NOT VERIFIED: no verification is recorded for the current changes. Run \`${command}\`, then fix or report any failing check.`;
  }
  if (outcome.result?.command === "verify" && hasCode(outcome.result, "PAVED_OPERATION_IN_PROGRESS")) {
    return "NOT VERIFIED: another Paved operation holds the project lock, so the recorded verification could not be read. " +
      `Wait for it to finish, then run \`${command}\`.`;
  }
  const failing = failingChecks(outcome.result);
  if (failing.length > 0) {
    return clip([`NOT VERIFIED: ${command} found failing checks. Fix them, or report why they cannot pass.`, ...failing].join("\n"), 2000);
  }
  const codes = [...new Set(diagnostics.map((item) => item?.code).filter((code) => typeof code === "string" && /^[A-Z0-9_]+$/.test(code)))].slice(0, 5);
  return `NOT VERIFIED: ${command} failed or could not complete` + (codes.length ? ` (${codes.join(", ")})` : "") +
    ". Inspect its output and correct or report the failure.";
}

const MAX_LISTED = 6;
const EXCERPT_LINES = 8;
const EXCERPT_CHARS = 800;

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safe(value, max = 160) {
  return typeof value === "string" ? clip(value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), max) : undefined;
}

// One entry per failing or blocked check, sharing a single excerpt budget so a long run
// stays a short message.
function failingChecks(result) {
  const checks = Array.isArray(result?.data?.checks) ? result.data.checks : [];
  const tolerated = new Set((Array.isArray(result?.data?.unproven) ? result.data.unproven : []).map((item) => item?.id));
  const failing = checks.filter((check) => ["failed", "error", "blocked"].includes(check?.status) && typeof check.id === "string")
    .sort((a, b) => Number(tolerated.has(a.id)) - Number(tolerated.has(b.id)));
  let lines = 0;
  let chars = 0;
  const entries = failing.slice(0, MAX_LISTED).map((check) => {
    const note = tolerated.has(check.id) ? (check.pre_existing ? ", pre-existing" : ", unproven") : "";
    const reason = safe(check.reason);
    const output = safe(check.output_ref, 200);
    const entry = [`- ${safe(check.id, 120)} (${check.status}${note})${reason ? `: ${reason}` : ""}${output ? ` Output: ${output}` : ""}`];
    for (const raw of Array.isArray(check.excerpt) ? check.excerpt : []) {
      const line = safe(raw, 200);
      if (!line || lines >= EXCERPT_LINES || chars + line.length > EXCERPT_CHARS) break;
      entry.push(`    ${line}`);
      lines += 1;
      chars += line.length;
    }
    return entry.join("\n");
  });
  if (failing.length > MAX_LISTED) entries.push(`- and ${failing.length - MAX_LISTED} more`);
  return entries;
}

// A warning proves everything except failures the base already had and checks this
// environment cannot run; it does not block, but says which ones.
function warningNote(result) {
  const unproven = Array.isArray(result?.data?.unproven) ? result.data.unproven.filter((item) => typeof item?.id === "string") : [];
  if (unproven.length === 0) return undefined;
  const group = (reason) => unproven.filter((item) => item.reason === reason).map((item) => safe(item.id, 120));
  const parts = [
    ["pre-existing on the base", group("pre-existing")],
    ["environment unavailable", group("environment-unavailable")],
    ["blocked by those", group("dependency-unproven")],
  ].filter(([, ids]) => ids.length > 0).map(([label, ids]) => `${label}: ${ids.slice(0, MAX_LISTED).join(", ")}${ids.length > MAX_LISTED ? ` and ${ids.length - MAX_LISTED} more` : ""}`);
  return clip(`Paved verify: warning, not blocking; unproven checks (${parts.join("; ")}).`, 600);
}

function openTasks(repository) {
  try {
    const dir = join(repository, ".paved", "tasks");
    if (lstatSync(dir).isSymbolicLink()) return [];
    return readdirSync(dir).filter((name) => /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)).sort().filter((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536 &&
        /^Status: open\r?$/m.test(readFileSync(path, "utf8"));
    }).slice(0, 3).map((name) => name.slice(0, 60));
  } catch { return []; }
}

let output = "";

function emit(value) {
  output = `${JSON.stringify(value)}\n`;
}

// A host that never closes stdin must not keep the hook waiting.
async function readInput() {
  process.stdin.setEncoding("utf8");
  let input = "";
  const guard = setTimeout(() => process.stdin.destroy(), STDIN_TIMEOUT_MS);
  try {
    for await (const chunk of process.stdin) input += chunk;
  } finally {
    clearTimeout(guard);
  }
  return input;
}

try {
  const event = JSON.parse(await readInput());
  if (!event || typeof event !== "object" || typeof event.cwd !== "string") process.exit(0);
  if (!["SessionStart", "Stop"].includes(event.hook_event_name)) process.exit(0);
  const sourceRoot = nearestRepository(event.cwd);
  if (!sourceRoot) process.exit(0);
  const repository = stateRepository(sourceRoot);
  const initialized = existsSync(join(repository, ".paved", "manifest.yaml"));

  if (event.hook_event_name === "SessionStart") {
    const host = process.argv[2] === "--host" ? process.argv[3] : undefined;
    const update = initialized && ["claude-code", "codex"].includes(host)
      ? await invoke(repository, sourceRoot, ["auto-update", "check", "--host", host], 300000, [0, 5])
      : undefined;
    const diagnosis = initialized ? await invoke(repository, sourceRoot, ["doctor", "--quick"], 10000) : undefined;
    const status = !initialized ? (existsSync(join(repository, ".paved")) ? "broken" : "uninitialized") :
      typeof diagnosis?.data?.status === "string" && /^[a-z-]+$/.test(diagnosis.data.status) ? diagnosis.data.status : "unknown";
    const tasks = initialized ? openTasks(repository) : [];
    const offer = (state, question) => [
      `Paved: ${state}.`,
      `Before the first code change in this session (feature, bug fix, refactor), ask the user once whether to ${question}.`,
      "Yes: run the Paved execute command with the request; it sets Paved up as needed, then applies rules and verification. Not now: work directly and do not ask again this session.",
      "Questions, investigation and operational tasks proceed without asking. Never initialize or repair without the user's yes.",
    ];
    const lines = status === "uninitialized" ? offer("uninitialized", "use Paved here") :
      status === "broken" ? offer("broken (.paved/ exists without a manifest)", "repair Paved and use it") : [
        `Paved: ${status}.`,
        tasks.length ? `Open task files: ${tasks.join(", ")} (select explicitly).` : "Open tasks: none listed.",
        "Rules: .paved/rules/; context: paved context <topic>.",
        "Route code changes (feature, bug fix, refactor) through the Paved execute command; answer questions directly. Explicit user direction wins. Updates require explicit authorization.",
      ];
    if (update?.data?.restartRequired === true) lines.push("Paved plugin updated; Restart this agent session.");
    else if (update?.status === "failed") lines.push("Paved plugin update did not complete; inspect `paved auto-update status` before retrying.");
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
  } else if (initialized) {
    const host = process.argv[2] === "--host" ? process.argv[3] : undefined;
    if (!["claude-code", "codex"].includes(host)) process.exit(0);
    const launcher = launcherFor(repository);
    const timeout = stopTimeout();
    const base = launcher ? defaultBase(sourceRoot) : undefined;
    const outcome = launcher
      ? await runLauncher(launcher, sourceRoot, ["verify", "--changed", ...(base ? ["--base", base] : []), "--recorded"], timeout)
      : { kind: "unavailable" };
    const result = outcome.kind === "completed" && [0, 1].includes(outcome.code) ? outcome.result : undefined;
    const verified = result?.command === "verify" && ["success", "warning"].includes(result.status) &&
      result.data?.completion?.status === "complete" && result.data?.completion?.verification === "verified";
    const note = result?.command === "verify" && result.status === "warning" && !verified ? warningNote(result) : undefined;
    if (outcome.kind === "completed" && hasCode(outcome.result, "PAVED_CLI_USAGE")) {
      // A runtime pinned before this hook's flags rejects them; that says nothing about the change.
      emit({ systemMessage: "Paved: the runtime pinned by this project cannot report recorded verification at turn end. " +
        `Run \`paved update\` to adopt the plugin's runtime; until then run \`${verifyCommand(base)}\` yourself.` });
    } else if (note) emit({ systemMessage: note });
    else if (!verified) {
      const reason = verificationFailure(outcome, timeout, base);
      emit(event.stop_hook_active === true ? { systemMessage: reason } : { decision: "block", reason });
    }
  }
} catch {
  // Hooks must not crash the host on malformed input or filesystem errors.
}

// Nothing may keep the process alive after the answer: flush it and exit.
process.stdout.write(output, () => process.exit(0));
