import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { copyProjectForInitDryRun, createInitDryRunWorkspace, initDryRunScratchPrefix, projectNameFor } from "../../cli/commands/init.ts";
import { hashLocalCore, hashLocalFile, hashLocalTree } from "../../cli/lib/local-core.ts";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { acquireConsumerOperationLock } from "../../cli/lib/operation-lock.ts";
import { renderHuman, renderJson } from "../../cli/output.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { exitCode, primaryCategory, type CommandResult } from "../../cli/result.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HEALTHY_FIXTURE = join(ROOT, "tests/cli/fixtures/healthy");
const VERIFICATION_FIXTURE = join(ROOT, "tests/cli/fixtures/verification");
afterEach(cleanupTemporaryDirectories);

interface ResolvedLockEntry {
  id?: string;
  version: string;
  source: string;
  sha256: string;
}

interface LockDocument {
  apiVersion: "paved/v1";
  kind: "Lock";
  resolved_at: string;
  core: ResolvedLockEntry;
  adapters?: ResolvedLockEntry[];
  generators?: ResolvedLockEntry[];
}

function sandbox(name: string): string {
  return temporaryDirectory(`paved-${name}`);
}

function fixtureCopy(name: string): string {
  const dir = sandbox(name);
  cpSync(HEALTHY_FIXTURE, dir, { recursive: true });
  return dir;
}

function verificationFixtureCopy(name: string): string {
  const dir = sandbox(name);
  cpSync(VERIFICATION_FIXTURE, dir, { recursive: true });
  chmodSync(join(dir, ".paved/tools/marker.mjs"), 0o755);
  chmodSync(join(dir, ".paved/tools/unlisted.mjs"), 0o755);
  return dir;
}

function currentLock(adapterIds = ["technology/java"]): LockDocument {
  return {
    apiVersion: "paved/v1",
    kind: "Lock",
    resolved_at: "2026-09-27T00:00:00Z",
    core: {
      version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string,
      source: "local-core",
      sha256: hashLocalCore(ROOT),
    },
    adapters: adapterIds.map((id) => ({
      id,
      version: "0.1.0",
      source: "local-core",
      sha256: hashLocalTree(ROOT, [`adapters/${id}`]),
    })),
    generators: localGeneratorEntries(),
  };
}

function localGeneratorEntries(root = ROOT): ResolvedLockEntry[] {
  const generators: { id: string; version: string }[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "runtime") walk(full);
        continue;
      }
      if (entry.name === "generator.yaml") {
        const contract = parse(readFileSync(full, "utf8")) as { id?: string; version?: string };
        if (typeof contract.id === "string" && typeof contract.version === "string") {
          generators.push({ id: contract.id, version: contract.version });
        }
      }
    }
  }
  walk(join(root, "generators"));
  return generators.sort((a, b) => a.id.localeCompare(b.id, "en")).map((generator) => ({
    id: generator.id,
    version: generator.version,
    source: "local-core",
    sha256: hashLocalTree(root, [`generators/${generator.id}`]),
  }));
}

function localGeneratorIds(root = ROOT): string[] {
  return localGeneratorEntries(root).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
}

function writeCurrentLock(project: string, adapterIds?: string[]): void {
  writeFileSync(join(project, ".paved/paved.lock"), stringify(currentLock(adapterIds)));
}

function snapshotFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        const path = relative(root, full).split(sep).join("/");
        files.set(path, hashLocalFile(root, path));
      }
    }
  }
  walk(root);
  return files;
}

function snapshotApplicationFiles(root: string): Map<string, string> {
  const files = snapshotFiles(root);
  for (const path of [...files.keys()]) {
    if (path === ".paved" || path.startsWith(".paved/")) files.delete(path);
  }
  return files;
}

function freshConsumer(name: string): string {
  const dir = sandbox(name);
  mkdirSync(join(dir, "web/src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(join(dir, "web/package.json"), JSON.stringify({
    name,
    dependencies: { "@angular/core": "^19.2.15" },
    scripts: { test: "node --test" },
  }));
  writeFileSync(join(dir, "web/angular.json"), "{\"projects\":{}}");
  writeFileSync(join(dir, "web/tsconfig.json"), "{\"compilerOptions\":{\"strict\":true}}");
  writeFileSync(join(dir, "web/src/app-routing.module.ts"), "const routes = [{ path: 'courses', component: CoursesPage }];\n");
  return dir;
}

async function run(projectRoot: string, command: "init" | "update" | "generate" | "status" | "doctor", extra: readonly string[] = []): Promise<CommandResult> {
  return dispatchCli({
    argv: [command, "--project", projectRoot, ...extra],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });
}

async function runAny(projectRoot: string, command: "init" | "update" | "generate" | "verify" | "status" | "doctor" | "gardener", extra: readonly string[] = []): Promise<CommandResult> {
  return dispatchCli({
    argv: [command, "--project", projectRoot, ...extra],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });
}

describe("command output, exit, and safety regressions", () => {
  it("reports an in-progress consumer operation as a conflict for generation, verification, and update", async () => {
    const project = freshConsumer("operation-lock-cli");
    let release: (() => void) | undefined;
    try {
      initializeConsumer(ROOT, project, "operation-lock-cli");
      const lockPath = join(project, ".paved/paved.lock");
      const lock = parse(readFileSync(lockPath, "utf8")) as LockDocument;
      lock.core.sha256 = "0".repeat(64);
      writeFileSync(lockPath, stringify(lock));
      release = acquireConsumerOperationLock(project, "fixture");
      const before = snapshotFiles(project);

      const generate = await run(project, "generate");
      const verify = await runAny(project, "verify");
      const update = await run(project, "update");
      const secondGenerate = await run(project, "generate");
      const secondUpdate = await run(project, "update");
      const gardener = await runAny(project, "gardener");

      for (const result of [generate, verify, update, secondGenerate, secondUpdate]) {
        assert.equal(exitCode(result), 8);
        assertCode(result, "PAVED_OPERATION_IN_PROGRESS");
      }
      assert.ok(exitCode(gardener) <= 1, JSON.stringify(gardener.diagnostics));
      assert.deepEqual(snapshotFiles(project), before);
    } finally {
      release?.();
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps warning exit behavior and JSON/human parity for actual command results", async () => {
    const project = fixtureCopy("warning-parity");
    try {
      writeCurrentLock(project);
      rmSync(join(project, ".paved/verification/profile.yaml"), { force: true });

      const result = await runAny(project, "status");
      const human = renderHuman(result);
      const json = JSON.parse(renderJson(result)) as CommandResult;

      assert.equal(result.status, "warning");
      assert.equal(primaryCategory(result), "findings");
      assert.equal(exitCode(result), 1);
      assert.deepEqual(json, result);
      for (const diagnostic of result.diagnostics) assert.match(human, new RegExp(diagnostic.code));
      assert.doesNotMatch(human, /\n\s*at\s+/);
      assert.doesNotMatch(renderJson(result), /\n\s*at\s+/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("rejects arbitrary verify arguments before running any executable or shell command", async () => {
    const project = verificationFixtureCopy("verify-arbitrary-args");
    try {
      const before = snapshotFiles(project);

      const result = await dispatchCli({
        argv: [
          "verify",
          "--project",
          project,
          "node",
          "-e",
          "import('node:fs').then(fs => fs.writeFileSync('.paved/generated/evidence/arbitrary.txt', 'ran'))",
        ],
        cwd: ROOT,
        executablePath: join(ROOT, "cli/index.ts"),
      });

      assert.equal(primaryCategory(result), "usage");
      assertCode(result, "PAVED_CLI_USAGE");
      assert.equal(existsSync(join(project, ".paved/generated/evidence/marker-called.txt")), false);
      assert.equal(existsSync(join(project, ".paved/generated/evidence/unlisted-called.txt")), false);
      assert.equal(existsSync(join(project, ".paved/generated/evidence/arbitrary.txt")), false);
      assert.deepEqual(snapshotFiles(project), before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

  describe("update command", () => {
    it("requires a valid existing lock before planning any write", async () => {
      const missing = fixtureCopy("update-missing-lock");
      const invalid = fixtureCopy("update-invalid-lock");
      try {
        rmSync(join(missing, ".paved/paved.lock"), { force: true });
        writeFileSync(join(invalid, ".paved/paved.lock"), "apiVersion: paved/v1\nkind: Lock\ncore: bad\n");
        const missingBefore = snapshotFiles(missing);
        const invalidBefore = snapshotFiles(invalid);

        const missingResult = await run(missing, "update");
        const invalidResult = await run(invalid, "update");

        assert.equal(primaryCategory(missingResult), "config");
        assert.equal(primaryCategory(invalidResult), "config");
        assertCode(missingResult, "PAVED_LOCK_MISSING");
        assertCode(invalidResult, "PAVED_LOCK_INVALID");
        assert.deepEqual(snapshotFiles(missing), missingBefore);
        assert.deepEqual(snapshotFiles(invalid), invalidBefore);
      } finally {
        rmSync(missing, { recursive: true, force: true });
        rmSync(invalid, { recursive: true, force: true });
      }
    });

    it("rejects unsupported adapter override flags without mutating the project", async () => {
      const project = fixtureCopy("update-adapter-flag");
      try {
        writeCurrentLock(project);
        const before = snapshotFiles(project);

        const result = await run(project, "update", ["--adapter", "technology/java"]);

        assert.equal(primaryCategory(result), "usage");
        assertCode(result, "PAVED_CLI_USAGE");
        assert.deepEqual(snapshotFiles(project), before);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("reports unchanged local Core and adapters as a no-op", async () => {
      const project = fixtureCopy("update-unchanged");
      try {
        writeCurrentLock(project);
        const before = snapshotFiles(project);

        const result = await run(project, "update");
        const data = dataOf(result) as { changed?: boolean; plannedWrites?: string[]; plannedGeneratorIds?: string[] };

        assert.equal(exitCode(result), 0);
        assert.equal(data.changed, false);
        assert.deepEqual(data.plannedWrites, []);
        assert.deepEqual(data.plannedGeneratorIds, []);
        assert.deepEqual(snapshotFiles(project), before);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("preflights compatible manifest ranges and blocks incompatible Core or adapter ranges", async () => {
      const incompatibleCore = fixtureCopy("update-incompatible-core");
      const incompatibleAdapter = fixtureCopy("update-incompatible-adapter");
      try {
        writeCurrentLock(incompatibleCore);
        writeCurrentLock(incompatibleAdapter);
        writeManifest(incompatibleCore, {
          apiVersion: "paved/v1",
          kind: "Project",
          project: { name: "incompatible-core" },
          paved: { core: "^9.0.0" },
          adapters: [{ id: "technology/java", version: "^0.1.0" }],
        });
        writeManifest(incompatibleAdapter, {
          apiVersion: "paved/v1",
          kind: "Project",
          project: { name: "incompatible-adapter" },
          paved: { core: "^0.2.0" },
          adapters: [{ id: "technology/java", version: "^9.0.0" }],
        });
        const coreBefore = snapshotFiles(incompatibleCore);
        const adapterBefore = snapshotFiles(incompatibleAdapter);

        const coreResult = await run(incompatibleCore, "update");
        const adapterResult = await run(incompatibleAdapter, "update");

        assert.equal(primaryCategory(coreResult), "config");
        assert.equal(primaryCategory(adapterResult), "resolution");
        assertCode(coreResult, "PAVED_MANIFEST_CORE_INCOMPATIBLE");
        assertCode(adapterResult, "PAVED_ADAPTER_INCOMPATIBLE");
        assert.deepEqual(snapshotFiles(incompatibleCore), coreBefore);
        assert.deepEqual(snapshotFiles(incompatibleAdapter), adapterBefore);
      } finally {
        rmSync(incompatibleCore, { recursive: true, force: true });
        rmSync(incompatibleAdapter, { recursive: true, force: true });
      }
    });

    it("plans local digest changes without network access and keeps dry-run immutable", async () => {
      const project = fixtureCopy("update-digest-dry-run");
      try {
        const lock = currentLock();
        lock.core.sha256 = "1".repeat(64);
        lock.adapters![0]!.sha256 = "2".repeat(64);
        lock.generators = localGeneratorEntries();
        lock.generators.find((entry) => entry.id === "project-context/architecture")!.sha256 = "3".repeat(64);
        writeFileSync(join(project, ".paved/paved.lock"), stringify(lock));
        const before = snapshotFiles(project);

        const result = await run(project, "update", ["--dry-run"]);
        const data = dataOf(result) as { dryRun?: boolean; plannedWrites?: string[]; plannedGeneratorIds?: string[]; remoteResolution?: string };

        assert.ok(exitCode(result) === 0 || exitCode(result) === 1);
        assert.equal(data.dryRun, true);
        assert.equal(data.remoteResolution, "unsupported");
        assert.ok(data.plannedWrites?.includes(".paved/paved.lock"));
        assert.ok(data.plannedGeneratorIds?.includes("project-context/architecture"));
        assert.deepEqual(snapshotFiles(project), before);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("reports update-created human-review proposals as non-blocking findings", async () => {
      const project = freshConsumer("update-proposed-finding");
      try {
        initializeConsumer(ROOT, project, "update-proposed-finding");
        const lock = parse(readFileSync(join(project, ".paved/paved.lock"), "utf8")) as LockDocument;
        lock.generators!.find((entry) => entry.id === "verification")!.sha256 = "6".repeat(64);
        writeFileSync(join(project, ".paved/paved.lock"), stringify(lock));

        const result = await run(project, "update");

        assert.equal(exitCode(result), 1);
        assert.equal(primaryCategory(result), "findings");
        assertCode(result, "PAVED_GENERATOR_PROPOSAL_CREATED");
        assert.equal(existsSync(join(project, ".paved/generated/proposals/verification/profile.yaml")), true);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("writes the lock only after successful preflight and safe generation", async () => {
      const project = fixtureCopy("update-digest-apply");
      try {
        const lock = currentLock();
        lock.core.sha256 = "4".repeat(64);
        writeFileSync(join(project, ".paved/paved.lock"), stringify(lock));
        const appBefore = snapshotApplicationFiles(project);

        const result = await run(project, "update");
        const updated = parse(readFileSync(join(project, ".paved/paved.lock"), "utf8")) as LockDocument;
        const data = dataOf(result) as { changed?: boolean; plannedWrites?: string[] };

        assert.equal(exitCode(result), 0);
        assert.equal(data.changed, true);
        assert.ok(data.plannedWrites?.includes(".paved/paved.lock"));
        assert.equal(updated.core.sha256, hashLocalCore(ROOT));
        assert.deepEqual(snapshotApplicationFiles(project), appBefore);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("runs newly discovered generator contracts before writing them to the lock", async () => {
      const project = freshConsumer("update-missing-generator-entry");
      try {
        initializeConsumer(ROOT, project, "update-missing-generator-entry");
        const lock = parse(readFileSync(join(project, ".paved/paved.lock"), "utf8")) as LockDocument;
        lock.generators = (lock.generators ?? []).filter((entry) => entry.id !== "project-context/architecture");
        writeFileSync(join(project, ".paved/paved.lock"), stringify(lock));
        const beforeDryRun = snapshotFiles(project);

        const dryRun = await run(project, "update", ["--dry-run"]);
        const dryRunData = dataOf(dryRun) as { plannedGeneratorIds?: string[]; plannedWrites?: string[] };

        assert.equal(exitCode(dryRun), 0);
        assert.deepEqual(dryRunData.plannedGeneratorIds, ["project-context/architecture"]);
        assert.ok(dryRunData.plannedWrites?.includes(".paved/paved.lock"));
        assert.deepEqual(snapshotFiles(project), beforeDryRun);

        const result = await run(project, "update");
        const updated = parse(readFileSync(join(project, ".paved/paved.lock"), "utf8")) as LockDocument;

        assert.equal(exitCode(result), 0);
        assert.deepEqual(updated.generators?.map((entry) => entry.id).sort(), localGeneratorIds());
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("turns human-edited generated output or untrusted baselines into conflicts and proposals", async () => {
      const humanEdited = freshConsumer("update-human-edited");
      const untrustedBaseline = freshConsumer("update-untrusted-baseline");
      try {
        for (const project of [humanEdited, untrustedBaseline]) {
          initializeConsumer(ROOT, project, "update-conflict");
          await run(project, "generate", ["project-context/architecture"]);
          const lock = parse(readFileSync(join(project, ".paved/paved.lock"), "utf8")) as LockDocument;
          lock.generators = [{ id: "project-context/architecture", version: "0.2.0", source: "local-core", sha256: "5".repeat(64) }];
          writeFileSync(join(project, ".paved/paved.lock"), stringify(lock));
        }

        const humanOutput = join(humanEdited, ".paved/project/architecture/overview.md");
        const humanContent = readFileSync(humanOutput, "utf8").replace("Implemented structure", "Human maintained structure");
        writeFileSync(humanOutput, humanContent);

        const baselinePath = join(untrustedBaseline, ".paved/generated/state/baselines", `${"0".repeat(64)}.json`);
        mkdirSync(dirname(baselinePath), { recursive: true });
        writeFileSync(baselinePath, stringify({ generator: "project-context/architecture", body: "tampered", sha256: "bad" }));
        const untrustedOutput = join(untrustedBaseline, ".paved/project/architecture/overview.md");
        const untrustedContent = readFileSync(untrustedOutput, "utf8").replace("Implemented structure", "Baseline changed structure");
        writeFileSync(untrustedOutput, untrustedContent);

        const humanBefore = snapshotApplicationFiles(humanEdited);
        const untrustedBefore = snapshotApplicationFiles(untrustedBaseline);
        const humanLockBefore = readFileSync(join(humanEdited, ".paved/paved.lock"));
        const untrustedLockBefore = readFileSync(join(untrustedBaseline, ".paved/paved.lock"));

        const humanResult = await run(humanEdited, "update");
        const untrustedResult = await run(untrustedBaseline, "update");
        const humanData = dataOf(humanResult) as { conflicts?: string[]; proposals?: string[] };
        const untrustedData = dataOf(untrustedResult) as { conflicts?: string[]; proposals?: string[] };

        assert.equal(primaryCategory(humanResult), "conflict");
        assert.equal(primaryCategory(untrustedResult), "conflict");
        assert.deepEqual(humanData.conflicts, ["project-context/architecture"]);
        assert.deepEqual(untrustedData.conflicts, ["project-context/architecture"]);
        assert.ok(humanData.proposals?.includes(".paved/generated/proposals/project/architecture/overview.md"));
        assert.ok(untrustedData.proposals?.includes(".paved/generated/proposals/project/architecture/overview.md"));
        assert.equal(readFileSync(humanOutput, "utf8"), humanContent);
        assert.equal(readFileSync(untrustedOutput, "utf8"), untrustedContent);
        assert.equal(readFileSync(join(humanEdited, ".paved/paved.lock")).equals(humanLockBefore), true);
        assert.equal(readFileSync(join(untrustedBaseline, ".paved/paved.lock")).equals(untrustedLockBefore), true);
        assert.deepEqual(snapshotApplicationFiles(humanEdited), humanBefore);
        assert.deepEqual(snapshotApplicationFiles(untrustedBaseline), untrustedBefore);
      } finally {
        rmSync(humanEdited, { recursive: true, force: true });
        rmSync(untrustedBaseline, { recursive: true, force: true });
      }
    });
  });

async function assertReadOnly(projectRoot: string, command: "status" | "doctor", extra: readonly string[] = []): Promise<CommandResult> {
  const before = snapshotFiles(projectRoot);
  const result = await run(projectRoot, command, extra);
  assert.deepEqual(snapshotFiles(projectRoot), before, `${command} must not modify files`);
  return result;
}

function codes(result: CommandResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function assertCode(result: CommandResult, code: string): void {
  assert.ok(codes(result).includes(code), `expected ${code}, got ${codes(result).join(", ")}`);
}

function dataOf(result: CommandResult): Record<string, unknown> {
  assert.equal(typeof result.data, "object");
  assert.notEqual(result.data, null);
  return result.data as Record<string, unknown>;
}

function writeManifest(project: string, manifest: unknown): void {
  mkdirSync(join(project, ".paved"), { recursive: true });
  writeFileSync(join(project, ".paved/manifest.yaml"), stringify(manifest));
}

describe("status and doctor commands", () => {
  it("reports pending decisions and a conversational next action without mutating them", async () => {
    const project = freshConsumer("status-decisions");
    try {
      const init = await run(project, "init");
      assert.equal(init.status, "awaiting_input");
      const before = snapshotFiles(join(project, ".paved/decisions"));
      const result = await run(project, "status");
      const data = dataOf(result) as {
        pendingDecisions: { id: string }[]; pendingApprovals: string[];
        verificationReadiness: string; unavailableCommands: { name: string; reason: string }[];
        nextAction: string;
      };
      assert.notEqual(result.status, "awaiting_input");
      assert.ok(data.pendingDecisions.length > 0);
      assert.ok(Array.isArray(data.pendingApprovals));
      assert.equal(data.verificationReadiness, "awaiting-decision");
      assert.ok(Array.isArray(data.unavailableCommands));
      assert.match(data.nextAction, /decision/i);
      assert.doesNotMatch(data.nextAction, /edit|create .*\.yaml/i);
      assert.deepEqual(snapshotFiles(join(project, ".paved/decisions")), before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
  it("includes command files in the local Core digest", () => {
    const core = sandbox("core-digest-cli-commands");
    try {
      writeFileSync(join(core, "VERSION"), "0.2.0\n");
      writeFileSync(join(core, "manifest.yaml"), "version: 0.2.0\n");
      mkdirSync(join(core, "schemas"), { recursive: true });
      mkdirSync(join(core, "core"), { recursive: true });
      mkdirSync(join(core, "generators"), { recursive: true });
      mkdirSync(join(core, "cli/commands"), { recursive: true });
      writeFileSync(join(core, "cli/commands/doctor.ts"), "export const command = 'doctor';\n");

      const before = hashLocalCore(core);
      writeFileSync(join(core, "cli/commands/doctor.ts"), "export const command = 'doctor-changed';\n");

      assert.notEqual(hashLocalCore(core), before);
    } finally {
      rmSync(core, { recursive: true, force: true });
    }
  });

  it("uses the same local Core digest when writing and checking the lock", async () => {
    const project = sandbox("runtime-lock-digest");
    try {
      writeFileSync(join(project, "README.md"), "# Runtime lock digest\n");
      initializeConsumer(ROOT, project, "runtime-lock-digest");
      const lock = parse(readFileSync(join(project, ".paved/paved.lock"), "utf8")) as LockDocument;

      const result = await assertReadOnly(project, "doctor");
      const data = dataOf(result) as { core?: { lockDigestMatches?: boolean } };

      assert.equal(lock.core.sha256, hashLocalCore(ROOT));
      assert.equal(data.core?.lockDigestMatches, true);
      assert.ok(!codes(result).includes("PAVED_LOCK_CORE_DIGEST_MISMATCH"));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports an uninitialized consumer without creating .paved", async () => {
    const project = sandbox("uninitialized");
    try {
      writeFileSync(join(project, "README.md"), "# Example\n");

      const status = await assertReadOnly(project, "status");
      const doctor = await assertReadOnly(project, "doctor");

      assert.equal(exitCode(status), 4);
      assert.equal(primaryCategory(status), "config");
      assert.equal(existsSync(join(project, ".paved")), false);
      assertCode(status, "PAVED_CONSUMER_UNINITIALIZED");
      assertCode(doctor, "PAVED_CONSUMER_UNINITIALIZED");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("summarizes a healthy initialized consumer with valid manifest and lock", async () => {
    const project = fixtureCopy("healthy");
    try {
      writeCurrentLock(project);

      const status = await assertReadOnly(project, "status");
      const doctor = await assertReadOnly(project, "doctor");
      const statusData = dataOf(status);

      assert.equal(exitCode(status), 0);
      assert.equal(exitCode(doctor), 0);
      assert.equal(statusData.projectName, "healthy");
      assert.equal(statusData.lockHealth, "healthy");
      assert.deepEqual(statusData.selectedAdapters, ["technology/java"]);
      assert.deepEqual(statusData.resolvedAdapters, ["technology/java"]);
      assert.equal(statusData.verificationProfile, "present");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports invalid manifest and invalid lock documents as config errors", async () => {
    const invalidManifest = fixtureCopy("invalid-manifest");
    const invalidLock = fixtureCopy("invalid-lock");
    try {
      writeFileSync(join(invalidManifest, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\nproject: bad\n");
      writeCurrentLock(invalidLock);
      writeFileSync(join(invalidLock, ".paved/paved.lock"), "apiVersion: paved/v1\nkind: Lock\ncore: bad\n");

      const manifestResult = await assertReadOnly(invalidManifest, "doctor");
      const lockResult = await assertReadOnly(invalidLock, "doctor");

      assert.equal(exitCode(manifestResult), 4);
      assert.equal(exitCode(lockResult), 4);
      assertCode(manifestResult, "PAVED_MANIFEST_INVALID");
      assertCode(lockResult, "PAVED_LOCK_INVALID");
    } finally {
      rmSync(invalidManifest, { recursive: true, force: true });
      rmSync(invalidLock, { recursive: true, force: true });
    }
  });

  it("compares lock Core version and digest against the locally available Core", async () => {
    const project = fixtureCopy("lock-core-mismatch");
    try {
      const lock = currentLock();
      lock.core.version = "9.9.9";
      lock.core.sha256 = "f".repeat(64);
      writeFileSync(join(project, ".paved/paved.lock"), stringify(lock));

      const result = await assertReadOnly(project, "doctor");

      assert.equal(exitCode(result), 4);
      assertCode(result, "PAVED_LOCK_CORE_VERSION_MISMATCH");
      assertCode(result, "PAVED_LOCK_CORE_DIGEST_MISMATCH");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports selected adapters that are unavailable, undetected, or locally drifted from the lock", async () => {
    const missing = fixtureCopy("missing-adapter");
    const undetected = fixtureCopy("undetected-adapter");
    const drifted = fixtureCopy("adapter-digest-mismatch");
    try {
      writeManifest(missing, {
        apiVersion: "paved/v1",
        kind: "Project",
        project: { name: "missing-adapter" },
        paved: { core: "^0.2.0" },
        adapters: [{ id: "technology/not-real", version: "^0.1.0" }],
      });
      writeCurrentLock(missing, []);
      writeManifest(undetected, {
        apiVersion: "paved/v1",
        kind: "Project",
        project: { name: "undetected-adapter" },
        paved: { core: "^0.2.0" },
        adapters: [{ id: "technology/angular", version: "^0.2.0" }],
      });
      writeCurrentLock(undetected, ["technology/angular"]);
      const lock = currentLock();
      lock.adapters![0]!.sha256 = "e".repeat(64);
      writeFileSync(join(drifted, ".paved/paved.lock"), stringify(lock));

      const missingResult = await assertReadOnly(missing, "doctor");
      const undetectedResult = await assertReadOnly(undetected, "doctor");
      const driftedResult = await assertReadOnly(drifted, "doctor");

      assertCode(missingResult, "PAVED_ADAPTER_UNAVAILABLE");
      assertCode(undetectedResult, "PAVED_ADAPTER_UNDETECTED");
      assertCode(driftedResult, "PAVED_LOCK_ADAPTER_DIGEST_MISMATCH");
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(undetected, { recursive: true, force: true });
      rmSync(drifted, { recursive: true, force: true });
    }
  });

  it("reports ambiguous adapter capabilities when the manifest does not select a provider", async () => {
    const workspace = sandbox("ambiguous-capability");
    const project = join(workspace, "project");
    const core = join(workspace, "core");
    try {
      cpSync(HEALTHY_FIXTURE, project, { recursive: true });
      cpSync(join(ROOT, "schemas"), join(core, "schemas"), { recursive: true });
      cpSync(join(ROOT, "core/capabilities"), join(core, "core/capabilities"), { recursive: true });
      cpSync(join(ROOT, "adapters/technology/java"), join(core, "adapters/technology/java"), { recursive: true });
      cpSync(join(ROOT, "adapters/technology/java"), join(core, "adapters/technology/java-alt"), { recursive: true });
      mkdirSync(join(core, "cli"), { recursive: true });
      writeFileSync(join(core, "package.json"), JSON.stringify({ version: "0.2.0" }));
      writeFileSync(join(core, "manifest.yaml"), readFileSync(join(ROOT, "manifest.yaml"), "utf8"));
      writeFileSync(join(core, "cli/index.ts"), "");
      let alt = readFileSync(join(core, "adapters/technology/java-alt/adapter.yaml"), "utf8");
      alt = alt.replace("id: technology/java", "id: technology/java-alt").replace("title: Java", "title: Java alternate");
      writeFileSync(join(core, "adapters/technology/java-alt/adapter.yaml"), alt);
      writeManifest(project, {
        apiVersion: "paved/v1",
        kind: "Project",
        project: { name: "ambiguous" },
        paved: { core: "^0.2.0" },
        adapters: [
          { id: "technology/java", version: "^0.1.0" },
          { id: "technology/java-alt", version: "^0.1.0" },
        ],
      });
      writeFileSync(join(project, ".paved/paved.lock"), stringify({
        apiVersion: "paved/v1",
        kind: "Lock",
        resolved_at: "2026-09-27T00:00:00Z",
        core: { version: "0.2.0", source: "local-core", sha256: hashLocalCore(core) },
        adapters: [
          { id: "technology/java", version: "0.1.0", source: "local-core", sha256: hashLocalTree(core, ["adapters/technology/java"]) },
          { id: "technology/java-alt", version: "0.1.0", source: "local-core", sha256: hashLocalTree(core, ["adapters/technology/java-alt"]) },
        ],
        generators: [],
      }));

      const result = await dispatchCli({
        argv: ["doctor", "--project", project],
        cwd: ROOT,
        executablePath: join(core, "cli/index.ts"),
      });

      assertCode(result, "PAVED_CAPABILITY_AMBIGUOUS");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports missing verification profile as a finding rather than authorizing verification", async () => {
    const project = fixtureCopy("missing-profile");
    try {
      writeCurrentLock(project);
      rmSync(join(project, ".paved/verification/profile.yaml"), { force: true });

      const result = await assertReadOnly(project, "status");

      assert.equal(exitCode(result), 1);
      assertCode(result, "PAVED_VERIFICATION_PROFILE_MISSING");
      assert.equal(dataOf(result).verificationProfile, "missing");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports pending proposals and conflict entries from the last generator run", async () => {
    const project = fixtureCopy("proposals-conflicts");
    try {
      writeCurrentLock(project);
      const stateDir = join(project, ".paved/generated/state");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "last-run.json"), JSON.stringify({
        executions: [
          { generator: "rules", status: "proposed", proposals: [".paved/generated/proposals/rules/style.yaml"], errors: [] },
          { generator: "project-context/architecture", status: "conflict", proposals: [".paved/generated/proposals/project/architecture/overview.md"], errors: ["conflict"] },
        ],
      }));

      const result = await assertReadOnly(project, "doctor");
      const data = dataOf(result);

      assertCode(result, "PAVED_GENERATOR_PROPOSALS_PENDING");
      assertCode(result, "PAVED_GENERATOR_CONFLICTS_PENDING");
      assert.deepEqual(data.proposals, [".paved/generated/proposals/rules/style.yaml", ".paved/generated/proposals/project/architecture/overview.md"]);
      assert.deepEqual(data.conflicts, ["project-context/architecture"]);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports tampered generated provenance without leaking document content", async () => {
    const project = fixtureCopy("tampered-provenance");
    try {
      writeCurrentLock(project);
      const output = join(project, ".paved/project/architecture/overview.md");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, [
        "---",
        "apiVersion: paved/v1",
        "kind: ContextDocument",
        "area: architecture",
        "title: Architecture",
        "confidence: observed",
        "provenance:",
        "  generator: project-context/architecture",
        "  generator_version: 0.2.0",
        "  generated_at: 2026-09-27T00:00:00Z",
        `  output_sha256: "${"0".repeat(64)}"`,
        "  sources:",
        "    - id: s1",
        "      type: file",
        "      location: pom.xml",
        "      sha256: " + hashLocalFile(project, "pom.xml"),
        "---",
        "<!-- paved:begin generated id=observations sources=s1 confidence=observed -->",
        "SECRET_SENTINEL_VALUE",
        "<!-- paved:end generated -->",
        "",
      ].join("\n"));

      const result = await assertReadOnly(project, "doctor");
      const human = renderHuman(result);
      const json = renderJson(result);

      assertCode(result, "PAVED_GENERATED_PROVENANCE_TAMPERED");
      assert.doesNotMatch(human, /SECRET_SENTINEL_VALUE/);
      assert.doesNotMatch(json, /SECRET_SENTINEL_VALUE/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("treats only required consumer layout entries as hard missing-required errors", async () => {
    const project = fixtureCopy("missing-required");
    try {
      writeCurrentLock(project);
      rmSync(join(project, ".paved/manifest.yaml"));

      const result = await assertReadOnly(project, "doctor");

      assert.equal(primaryCategory(result), "config");
      assertCode(result, "PAVED_CONSUMER_REQUIRED_PATH_MISSING");
      assert.doesNotMatch(renderHuman(result), /\.paved\/project\/.*required/i);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps JSON and human output in parity by rendering the same diagnostic codes and summary fields", async () => {
    const project = fixtureCopy("json-human-parity");
    try {
      writeCurrentLock(project);
      rmSync(join(project, ".paved/verification/profile.yaml"), { force: true });

      const result = await assertReadOnly(project, "doctor");
      const parsed = JSON.parse(renderJson(result)) as CommandResult;
      const human = renderHuman(result);

      assert.deepEqual(parsed, result);
      for (const diagnostic of result.diagnostics) assert.match(human, new RegExp(diagnostic.code));
      assert.match(human, /verificationProfile/);
      assert.match(human, /missing/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("init and generate commands", () => {
  it("plans a fresh init in dry-run mode without creating .paved", async () => {
    const project = freshConsumer("init-dry-run");
    try {
      const before = snapshotFiles(project);

      const result = await run(project, "init", ["--dry-run"]);
      const data = dataOf(result) as { plannedWrites?: string[]; selectedAdapters?: string[]; generation?: { executions?: { generator: string }[] } };

      assert.equal(exitCode(result), 1);
      assertCode(result, "PAVED_GENERATOR_PROPOSAL_CREATED");
      assert.deepEqual(snapshotFiles(project), before);
      assert.equal(existsSync(join(project, ".paved")), false);
      assert.ok(data.plannedWrites?.includes(".paved/manifest.yaml"));
      assert.ok(data.plannedWrites?.includes(".paved/paved.lock"));
      assert.ok(data.selectedAdapters?.includes("technology/angular"));
      assert.ok(data.generation?.executions?.some((entry) => entry.generator === "project-context/architecture"));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("derives init dry-run scratch workspaces from an OS temp parent, not the Core or consumer tree", () => {
    const project = freshConsumer("init-dry-run-temp-path-project");
    const tempParent = sandbox("init-dry-run-temp-parent");
    try {
      const syntheticOsTemp = resolve(ROOT, "..", "os-temp-parent");
      const prefix = initDryRunScratchPrefix(syntheticOsTemp);
      const workspace = createInitDryRunWorkspace(tempParent);

      assert.equal(prefix, join(syntheticOsTemp, "paved-init-dry-run-"));
      assert.equal(prefix.startsWith(ROOT + sep), false);
      assert.equal(prefix.startsWith(project + sep), false);
      assert.equal(workspace.startsWith(initDryRunScratchPrefix(tempParent)), true);
      assert.equal(existsSync(workspace), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it("copies init dry-run inputs without ignored secrets or agent state", async () => {
    const project = freshConsumer("init-dry-run-copy-exclusions");
    const workspace = sandbox("init-dry-run-copy-exclusions-target");
    const copy = join(workspace, "consumer");
    const secret = `secret-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(join(project, ".env"), `API_TOKEN=${secret}\n`);
      writeFileSync(join(project, ".env.local"), `API_TOKEN=${secret}\n`);
      for (const directory of [".claude", ".agents", ".superpowers"]) {
        mkdirSync(join(project, directory), { recursive: true });
        writeFileSync(join(project, directory, "state.txt"), secret);
      }

      copyProjectForInitDryRun(project, copy);
      const result = await run(project, "init", ["--dry-run"]);

      assert.equal(existsSync(join(copy, ".env")), false);
      assert.equal(existsSync(join(copy, ".env.local")), false);
      assert.equal(existsSync(join(copy, ".claude")), false);
      assert.equal(existsSync(join(copy, ".agents")), false);
      assert.equal(existsSync(join(copy, ".superpowers")), false);
      assert.equal(JSON.stringify(result).includes(secret), false, "dry-run result must not include ignored file contents");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps git adapter selection consistent in init dry-run generation previews", async () => {
    const project = freshConsumer("init-dry-run-git-adapter");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: project });
      execFileSync("git", ["add", "."], { cwd: project });
      execFileSync("git", ["-c", "user.name=Paved Test", "-c", "user.email=paved@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: project });
      execFileSync("git", ["switch", "--quiet", "-c", "build"], { cwd: project });

      const result = await run(project, "init", ["--dry-run"]);
      const data = dataOf(result) as {
        selectedAdapters?: string[];
        generation?: { selectedAdapters?: string[] };
      };

      assert.ok(data.selectedAdapters?.includes("infrastructure/git"));
      assert.ok(data.generation?.selectedAdapters?.includes("infrastructure/git"));
      const scratch = sandbox("init-dry-run-git-copy");
      try {
        const copy = join(scratch, "consumer");
        copyProjectForInitDryRun(project, copy);
        assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: copy, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim());
        assert.deepEqual(readdirSync(join(copy, ".git")).sort(), ["HEAD", "config", "objects", "refs"]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps unborn Git repositories isolated from an enclosing repository in init dry-run copies", () => {
    const project = freshConsumer("init-dry-run-unborn-git");
    const scratch = sandbox("init-dry-run-unborn-copy");
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: project });
      const copy = join(scratch, "consumer");

      copyProjectForInitDryRun(project, copy);

      assert.equal(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: copy, encoding: "utf8" }).trim(), realpathSync(copy));
      assert.throws(() => execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: copy,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }));
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("preserves SHA-256 Git object format in init dry-run metadata", () => {
    const project = freshConsumer("init-dry-run-sha256-git");
    const scratch = sandbox("init-dry-run-sha256-copy");
    try {
      execFileSync("git", ["init", "--quiet", "--object-format=sha256"], { cwd: project });
      execFileSync("git", ["add", "."], { cwd: project });
      execFileSync("git", ["-c", "user.name=Paved Test", "-c", "user.email=paved@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: project });
      const copy = join(scratch, "consumer");

      copyProjectForInitDryRun(project, copy);

      assert.equal(execFileSync("git", ["rev-parse", "--show-object-format"], { cwd: copy, encoding: "utf8" }).trim(), "sha256");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: copy, encoding: "utf8" }).trim(), execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim());
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects adapter override flags for init and generate instead of ignoring them", async () => {
    const initProject = freshConsumer("init-adapter-flag");
    const generateProject = freshConsumer("generate-adapter-flag");
    try {
      initializeConsumer(ROOT, generateProject, "generate-adapter-flag");
      const initBefore = snapshotFiles(initProject);
      const generateBefore = snapshotFiles(generateProject);

      const initResult = await run(initProject, "init", ["--adapter", "technology/angular"]);
      const generateResult = await run(generateProject, "generate", ["--adapter", "technology/angular"]);

      assert.equal(primaryCategory(initResult), "usage");
      assert.equal(primaryCategory(generateResult), "usage");
      assertCode(initResult, "PAVED_CLI_USAGE");
      assertCode(generateResult, "PAVED_CLI_USAGE");
      assert.deepEqual(snapshotFiles(initProject), initBefore);
      assert.deepEqual(snapshotFiles(generateProject), generateBefore);
    } finally {
      rmSync(initProject, { recursive: true, force: true });
      rmSync(generateProject, { recursive: true, force: true });
    }
  });

  it("initializes a fresh consumer and honors --no-generate", async () => {
    const project = freshConsumer("init-no-generate");
    try {
      const appBefore = snapshotApplicationFiles(project);

      const result = await run(project, "init", ["--no-generate"]);

      assert.equal(exitCode(result), 10);
      assert.ok((result.decisions?.length ?? 0) > 0);
      assert.equal(existsSync(join(project, ".paved/manifest.yaml")), true);
      assert.equal(existsSync(join(project, ".paved/paved.lock")), true);
      assert.equal(existsSync(join(project, ".paved/project")), false);
      assert.equal(existsSync(join(project, ".paved/generated/state/last-run.json")), false);
      assert.deepEqual(snapshotApplicationFiles(project), appBefore);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("runs generation during fresh init unless --no-generate is supplied", async () => {
    const project = freshConsumer("init-with-generate");
    try {
      const appBefore = snapshotApplicationFiles(project);

      const result = await run(project, "init");

      assert.equal(exitCode(result), 10);
      assert.ok((result.decisions?.length ?? 0) > 0);
      assertCode(result, "PAVED_GENERATOR_PROPOSAL_CREATED");
      assert.equal(existsSync(join(project, ".paved/manifest.yaml")), true);
      assert.equal(existsSync(join(project, ".paved/paved.lock")), true);
      assert.equal(existsSync(join(project, ".paved/generated/state/last-run.json")), true);
      assert.equal(existsSync(join(project, ".paved/project/architecture/overview.md")), true);
      assert.deepEqual(snapshotApplicationFiles(project), appBefore);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("refuses to reset already initialized state and leaves files byte-identical", async () => {
    const project = freshConsumer("init-existing");
    try {
      initializeConsumer(ROOT, project, "init-existing");
      const architecture = join(project, ".paved/project/architecture/overview.md");
      mkdirSync(dirname(architecture), { recursive: true });
      writeFileSync(architecture, "human maintained context\n");
      const before = snapshotFiles(project);

      const result = await run(project, "init");

      assert.equal(primaryCategory(result), "config");
      assertCode(result, "PAVED_INIT_ALREADY_INITIALIZED");
      assert.deepEqual(snapshotFiles(project), before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("validates existing manifest and lock before refusing init", async () => {
    const project = freshConsumer("init-invalid-existing");
    try {
      mkdirSync(join(project, ".paved"), { recursive: true });
      writeFileSync(join(project, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\nproject: bad\n");
      writeFileSync(join(project, ".paved/paved.lock"), "apiVersion: paved/v1\nkind: Lock\ncore: bad\n");
      const before = snapshotFiles(project);

      const result = await run(project, "init");

      assert.equal(primaryCategory(result), "config");
      assertCode(result, "PAVED_MANIFEST_INVALID");
      assertCode(result, "PAVED_LOCK_INVALID");
      assert.deepEqual(snapshotFiles(project), before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("generate supports selectors, dry-run immutability, and source-file safety", async () => {
    const project = freshConsumer("generate-selectors");
    try {
      initializeConsumer(ROOT, project, "generate-selectors");
      const beforeDryRun = snapshotFiles(project);
      const appBefore = snapshotApplicationFiles(project);

      const dryRun = await run(project, "generate", ["--dry-run", "project-context/feature-map"]);
      const dryRunData = dataOf(dryRun) as { executions?: { generator: string }[] };

      assert.equal(exitCode(dryRun), 0);
      assert.deepEqual(snapshotFiles(project), beforeDryRun);
      assert.deepEqual(dryRunData.executions?.map((entry) => entry.generator), [
        "project-context/architecture",
        "project-context/domain",
        "project-context/product",
        "project-context/feature-map",
      ]);

      const generated = await run(project, "generate", ["project-context/feature-map"]);
      const generatedData = dataOf(generated) as { executions?: { generator: string }[] };

      assert.equal(exitCode(generated), 0);
      assert.deepEqual(generatedData.executions?.map((entry) => entry.generator), [
        "project-context/architecture",
        "project-context/domain",
        "project-context/product",
        "project-context/feature-map",
      ]);
      assert.equal(existsSync(join(project, ".paved/project/feature-map/web-courses.yaml")), true);
      assert.equal(existsSync(join(project, ".paved/generated/proposals/verification/profile.yaml")), false);
      assert.deepEqual(snapshotApplicationFiles(project), appBefore);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports generated human-review proposals as non-blocking findings", async () => {
    const project = freshConsumer("generate-proposed-finding");
    try {
      initializeConsumer(ROOT, project, "generate-proposed-finding");

      const result = await run(project, "generate", ["verification"]);

      assert.equal(exitCode(result), 1);
      assert.equal(primaryCategory(result), "findings");
      assertCode(result, "PAVED_GENERATOR_PROPOSAL_CREATED");
      assert.equal(existsSync(join(project, ".paved/generated/proposals/verification/profile.yaml")), true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps existing pending proposals visible after an unchanged generate run", async () => {
    const project = freshConsumer("generate-proposal-persists");
    try {
      initializeConsumer(ROOT, project, "generate-proposal-persists");

      const first = await run(project, "generate", ["verification"]);
      const second = await run(project, "generate", ["verification"]);
      const status = await assertReadOnly(project, "status");
      const data = dataOf(status) as { proposals?: string[] };
      const proposal = ".paved/generated/proposals/verification/profile.yaml";

      assert.equal(exitCode(first), 1);
      assert.equal(exitCode(second), 0);
      assert.equal(existsSync(join(project, proposal)), true);
      assertCode(status, "PAVED_GENERATOR_PROPOSALS_PENDING");
      assert.ok(data.proposals?.includes(proposal));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("reports dry-run human-review proposals as planned without claiming writes", async () => {
    const project = freshConsumer("generate-dry-run-proposed-finding");
    try {
      initializeConsumer(ROOT, project, "generate-dry-run-proposed-finding");
      const before = snapshotFiles(project);

      const result = await run(project, "generate", ["--dry-run", "verification"]);
      const diagnostic = result.diagnostics.find((entry) => entry.code === "PAVED_GENERATOR_PROPOSAL_CREATED");

      assert.equal(exitCode(result), 1);
      assert.equal(primaryCategory(result), "findings");
      assert.match(diagnostic?.message ?? "", /would create proposal/i);
      assert.doesNotMatch(diagnostic?.message ?? "", /\bwrote\b/i);
      assert.equal(existsSync(join(project, ".paved/generated/proposals/verification/profile.yaml")), false);
      assert.deepEqual(snapshotFiles(project), before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("generate maps invalid selectors to usage diagnostics without writes", async () => {
    const project = freshConsumer("generate-invalid-selector");
    try {
      initializeConsumer(ROOT, project, "generate-invalid-selector");
      const before = snapshotFiles(project);

      const result = await run(project, "generate", ["project-context/not-real"]);

      assert.equal(primaryCategory(result), "usage");
      assertCode(result, "PAVED_GENERATOR_SELECTOR_UNKNOWN");
      assert.deepEqual(snapshotFiles(project), before);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("generate reports conflicts and proposals without overwriting human edits", async () => {
    const project = freshConsumer("generate-conflict");
    try {
      initializeConsumer(ROOT, project, "generate-conflict");
      await run(project, "generate", ["project-context/architecture"]);
      const architecture = join(project, ".paved/project/architecture/overview.md");
      const humanEdited = readFileSync(architecture, "utf8").replace("Implemented structure", "Human maintained structure");
      writeFileSync(architecture, humanEdited);
      const appBefore = snapshotApplicationFiles(project);

      const result = await run(project, "generate", ["project-context/architecture"]);
      const data = dataOf(result) as { conflicts?: string[]; proposals?: string[] };

      assert.equal(primaryCategory(result), "conflict");
      assert.deepEqual(data.conflicts, ["project-context/architecture"]);
      assert.ok(data.proposals?.some((path) => path === ".paved/generated/proposals/project/architecture/overview.md"));
      assert.equal(readFileSync(architecture, "utf8"), humanEdited);
      assert.deepEqual(snapshotApplicationFiles(project), appBefore);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("init project naming", () => {
  it("maps any directory name onto a valid project slug", () => {
    assert.equal(projectNameFor("/work/my-service"), "my-service");
    assert.equal(projectNameFor("/work/My_Service.v2"), "my-service-v2");
    assert.equal(projectNameFor("/tmp/tmp.AbC123"), "tmp-abc123");
    assert.equal(projectNameFor("/work/--Paved--"), "paved");
    assert.equal(projectNameFor("/work/___"), "project");
  });
});
