import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { inspectConsumer } from "../../cli/lib/consumer-state.ts";
import { initializeConsumer, runGenerators } from "../../cli/lib/generator-runtime.ts";
import { planConsumerUpdate } from "../../cli/lib/consumer-state.ts";
import { applyConsumerUpdate } from "../../cli/lib/update-transaction.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { hashLocalFile, hashLocalTree } from "../../cli/lib/local-core.ts";
import { exitCode } from "../../cli/result.ts";
import { CORE_VERSION, cleanupTemporaryDirectories, temporaryDirectory, temporaryFixture } from "../helpers.ts";

const core = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = join(core, "tests/fixtures/consumers");
afterEach(cleanupTemporaryDirectories);

function consumer(name: string): string {
  return temporaryFixture(join(fixtures, name), `paved-${name}`);
}
function state(path: string) { return inspectConsumer({ projectRoot: path, coreRoot: core }).lifecycleState; }

test("consumer identity and lifecycle are derived from local manifest and evidence", () => {
  const a = consumer("consumer-a");
  const b = consumer("consumer-b");
  try {
    assert.equal(state(a), "UNINITIALIZED");
    initializeConsumer(core, a, "consumer-a");
    initializeConsumer(core, b, "consumer-b");
    assert.equal(state(a), "RESOLVED");
    assert.equal(state(b), "RESOLVED");
    const lockB = readFileSync(join(b, ".paved/paved.lock"));
    runGenerators(core, a);
    assert.equal(readFileSync(join(b, ".paved/paved.lock")).equals(lockB), true);
    assert.equal(state(a), "GENERATED");
    assert.equal(state(b), "RESOLVED");
    writeFileSync(join(a, "README.md"), "# Changed input\n");
    assert.equal(state(a), "STALE");
    const stalePlan = planConsumerUpdate({ projectRoot: a, coreRoot: core });
    assert.equal(stalePlan.changed, true);
    assert.ok(stalePlan.plannedGeneratorIds.includes("project-context/architecture"));
    assert.ok(!stalePlan.plannedWrites.includes(".paved/paved.lock"));
    assert.equal(state(b), "RESOLVED");
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("invalid and incompatible consumers have distinct lifecycle states", () => {
  const invalid = consumer("consumer-invalid");
  const incompatible = consumer("consumer-incompatible");
  const stale = consumer("consumer-stale");
  const staleLock = join(stale, ".paved/paved.lock");
  const pinned = parse(readFileSync(staleLock, "utf8")) as { core: { version: string } };
  pinned.core.version = CORE_VERSION;
  writeFileSync(staleLock, stringify(pinned));
  try {
    assert.equal(state(invalid), "BROKEN");
    assert.equal(state(incompatible), "INCOMPATIBLE");
    assert.equal(state(stale), "STALE");
  } finally { rmSync(invalid, { recursive: true, force: true }); rmSync(incompatible, { recursive: true, force: true }); rmSync(stale, { recursive: true, force: true }); }
});

test("update dry run and failed preflight leave separate consumers untouched", () => {
  const a = consumer("consumer-a");
  const b = consumer("consumer-b");
  try {
    initializeConsumer(core, a, "consumer-a");
    initializeConsumer(core, b, "consumer-b");
    const lockA = join(a, ".paved/paved.lock");
    const parsed = parse(readFileSync(lockA, "utf8")) as { core: { sha256: string } };
    parsed.core.sha256 = "a".repeat(64);
    writeFileSync(lockA, stringify(parsed));
    const beforeA = readFileSync(lockA);
    const beforeB = readFileSync(join(b, ".paved/paved.lock"));
    assert.equal(planConsumerUpdate({ projectRoot: a, coreRoot: core }).changed, true);
    assert.equal(readFileSync(lockA).equals(beforeA), true);
    assert.equal(readFileSync(join(b, ".paved/paved.lock")).equals(beforeB), true);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("failed staged update keeps the original lock and generated state byte for byte", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    const lock = readFileSync(join(a, ".paved/paved.lock"));
    const manifest = readFileSync(join(a, ".paved/manifest.yaml"));
    assert.throws(() => applyConsumerUpdate(a, (staged) => {
      writeFileSync(join(staged, ".paved/paved.lock"), "invalid");
      throw new Error("staged validation failed");
    }), /staged validation failed/);
    assert.equal(readFileSync(join(a, ".paved/paved.lock")).equals(lock), true);
    assert.equal(readFileSync(join(a, ".paved/manifest.yaml")).equals(manifest), true);
    assert.equal(existsSync(join(a, ".paved-operation-lock")), false);
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("rejected staged update leaves authoritative state untouched and removes its workspace", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    const before = hashLocalTree(a, [".paved"]);
    let stagedRoot: string | undefined;
    const result = applyConsumerUpdate(a, (staged) => {
      stagedRoot = staged;
      writeFileSync(join(staged, ".paved/paved.lock"), "staged change");
      return "rejected";
    }, {
      commitIf: () => false,
      onRejected: (staged, value) => {
        assert.equal(staged, stagedRoot);
        assert.equal(value, "rejected");
      },
    });

    assert.equal(result, "rejected");
    assert.equal(hashLocalTree(a, [".paved"]), before);
    assert.equal(existsSync(join(a, ".paved-operation-lock")), false);
    assert.ok(stagedRoot);
    assert.equal(existsSync(stagedRoot), false);
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("staged update refuses to overwrite consumer state changed before commit", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    const manifestPath = join(a, ".paved/manifest.yaml");
    const concurrentManifest = `${readFileSync(manifestPath, "utf8")}\n# concurrent edit\n`;

    assert.throws(() => applyConsumerUpdate(a, (staged) => {
      writeFileSync(join(staged, ".paved/paved.lock"), "staged change");
      writeFileSync(manifestPath, concurrentManifest);
      return "staged";
    }), /Consumer state or repository evidence changed during update/);

    assert.equal(readFileSync(manifestPath, "utf8"), concurrentManifest);
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("failed directory swap restores the previous consumer state", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    const original = hashLocalTree(a, [".paved"]);
    let stagedRoot: string | undefined;

    assert.throws(() => applyConsumerUpdate(a, (staged) => {
      stagedRoot = staged;
      rmSync(join(staged, ".paved"), { recursive: true });
      return "commit";
    }));

    assert.equal(hashLocalTree(a, [".paved"]), original);
    assert.equal(existsSync(join(a, ".paved.update-backup")), false);
    assert.ok(stagedRoot);
    assert.equal(existsSync(stagedRoot), false);
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("unfinished update backup blocks another transaction without changing either state", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    const original = hashLocalTree(a, [".paved"]);
    mkdirSync(join(a, ".paved.update-backup"));
    writeFileSync(join(a, ".paved.update-backup", "recovery-marker"), "preserve");

    assert.throws(() => applyConsumerUpdate(a, () => "unused"), /unfinished update backup exists/);

    assert.equal(hashLocalTree(a, [".paved"]), original);
    assert.equal(readFileSync(join(a, ".paved.update-backup", "recovery-marker"), "utf8"), "preserve");
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("update rejects an override whose inherited target was removed", () => {
  const a = consumer("consumer-with-overrides");
  try {
    initializeConsumer(core, a, "consumer-with-overrides");
    writeFileSync(join(a, ".paved/overrides/overrides.yaml"), stringify({
      apiVersion: "paved/v1", kind: "Overrides",
      skills: [{ target: "core.missing.removed", action: "disable", owner: "team", reason: "test" }],
    }));
    const before = readFileSync(join(a, ".paved/paved.lock"));
    const plan = planConsumerUpdate({ projectRoot: a, coreRoot: core });
    assert.ok(plan.diagnostics.some((item) => item.code === "PAVED_OVERRIDE_TARGET_MISSING"));
    assert.equal(readFileSync(join(a, ".paved/paved.lock")).equals(before), true);
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("generator contract changes mark existing downstream context for regeneration", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    runGenerators(core, a);
    const lockPath = join(a, ".paved/paved.lock");
    const lock = parse(readFileSync(lockPath, "utf8")) as { generators: { id: string; sha256: string }[] };
    lock.generators.find((entry) => entry.id === "project-context/architecture")!.sha256 = "b".repeat(64);
    writeFileSync(lockPath, stringify(lock));
    const plan = planConsumerUpdate({ projectRoot: a, coreRoot: core });
    assert.ok(plan.plannedGeneratorIds.includes("project-context/architecture"));
    assert.ok(plan.plannedGeneratorIds.includes("project-context/domain"));
    assert.ok(plan.plannedGeneratorIds.includes("project-context/product"));
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("source staleness follows generator inputs and ignores unrelated files", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    runGenerators(core, a);
    assert.equal(state(a), "GENERATED");
    writeFileSync(join(a, "scratch.bin"), "unrelated");
    assert.equal(state(a), "GENERATED");
    writeFileSync(join(a, "package.json"), '{"name":"consumer-a"}\n');
    assert.equal(state(a), "STALE");
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("source-only update commits generated context while preserving another consumer", async () => {
  const a = consumer("consumer-a");
  const b = consumer("consumer-b");
  try {
    initializeConsumer(core, a, "consumer-a");
    initializeConsumer(core, b, "consumer-b");
    runGenerators(core, a);
    const originalLock = readFileSync(join(a, ".paved/paved.lock"));
    const otherBefore = hashLocalTree(b, [".paved"]);
    const changedSource = "# Changed input for A\n";
    writeFileSync(join(a, "README.md"), changedSource);
    const result = await dispatchCli({ argv: ["update", "--project", a], cwd: core, executablePath: join(core, "cli/index.ts") });
    assert.ok(exitCode(result) <= 1, JSON.stringify(result.diagnostics));
    assert.equal(state(a), "GENERATED");
    assert.equal(readFileSync(join(a, ".paved/paved.lock")).equals(originalLock), true);
    assert.equal(readFileSync(join(a, "README.md"), "utf8"), changedSource);
    assert.equal(hashLocalTree(b, [".paved"]), otherBefore);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("unknown Core movement and invalid project context block update before writes", () => {
  const unknown = consumer("consumer-a");
  const migration = consumer("consumer-b");
  try {
    initializeConsumer(core, unknown, "consumer-a");
    initializeConsumer(core, migration, "consumer-b");
    const lockPath = join(unknown, ".paved/paved.lock");
    const lock = parse(readFileSync(lockPath, "utf8")) as { core: { version: string } };
    lock.core.version = "0.1.0";
    writeFileSync(lockPath, stringify(lock));
    const unknownPlan = planConsumerUpdate({ projectRoot: unknown, coreRoot: core });
    assert.equal(unknownPlan.compatibility, "unknown");
    assert.ok(unknownPlan.diagnostics.some((item) => item.code === "PAVED_UPDATE_COMPATIBILITY_UNKNOWN"));
    mkdirSync(join(migration, ".paved/project/domain"), { recursive: true });
    writeFileSync(join(migration, ".paved/project/domain/overview.md"), "---\napiVersion: paved/v2\nkind: ContextDocument\n---\nInvalid\n");
    const migrationPlan = planConsumerUpdate({ projectRoot: migration, coreRoot: core });
    assert.equal(migrationPlan.compatibility, "migration-required");
    assert.ok(migrationPlan.diagnostics.some((item) => item.code === "PAVED_UPDATE_MIGRATION_REQUIRED"));
  } finally { rmSync(unknown, { recursive: true, force: true }); rmSync(migration, { recursive: true, force: true }); }
});

test("ready requires a valid profile and no pending human review", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    runGenerators(core, a, { generators: ["project-context/architecture"] });
    assert.equal(state(a), "GENERATED");
    mkdirSync(join(a, ".paved/verification"), { recursive: true });
    writeFileSync(join(a, ".paved/verification/profile.yaml"), "apiVersion: paved/v1\nkind: VerificationProfile\nchecks: []\n");
    assert.equal(state(a), "READY");
    mkdirSync(join(a, ".paved/generated/proposals"), { recursive: true });
    writeFileSync(join(a, ".paved/generated/proposals/review.txt"), "Review");
    assert.equal(state(a), "VALIDATED");
    rmSync(join(a, ".paved/paved.lock"));
    assert.equal(state(a), "INITIALIZED");
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("lock stays portable and changed override digests require review", () => {
  const a = consumer("consumer-with-overrides");
  try {
    initializeConsumer(core, a, "consumer-with-overrides");
    const lock = readFileSync(join(a, ".paved/paved.lock"), "utf8");
    assert.ok(!lock.includes(a));
    assert.ok(!lock.includes(core));
    const target = "core.architecture.follow-existing-patterns";
    const targetPath = "core/rules/architecture/follow-existing-patterns.yaml";
    const digest = hashLocalFile(core, targetPath);
    const path = join(a, ".paved/overrides/overrides.yaml");
    writeFileSync(path, stringify({ apiVersion: "paved/v1", kind: "Overrides",
      rules: [{ target, action: "disable", owner: "team", reason: "local exception", target_sha256: digest }] }));
    assert.ok(!planConsumerUpdate({ projectRoot: a, coreRoot: core }).diagnostics.some((item) => item.code === "PAVED_OVERRIDE_TARGET_CHANGED"));
    writeFileSync(path, stringify({ apiVersion: "paved/v1", kind: "Overrides",
      rules: [{ target, action: "disable", owner: "team", reason: "local exception", target_sha256: "0".repeat(64) }] }));
    assert.ok(planConsumerUpdate({ projectRoot: a, coreRoot: core }).diagnostics.some((item) => item.code === "PAVED_OVERRIDE_TARGET_CHANGED"));
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("transaction refuses symlinked consumer state before any staged write", () => {
  const a = consumer("consumer-a");
  const outside = join(temporaryDirectory("paved-outside"), "outside");
  try {
    initializeConsumer(core, a, "consumer-a");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(a, ".paved/external"));
    assert.throws(() => applyConsumerUpdate(a, () => undefined), /symbolic link/);
    assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(outside, { force: true }); }
});

test("missing generated context is stale and update plans its generator", () => {
  const a = consumer("consumer-a");
  try {
    initializeConsumer(core, a, "consumer-a");
    runGenerators(core, a, { generators: ["project-context/architecture"] });
    rmSync(join(a, ".paved/project/architecture/overview.md"));
    assert.equal(state(a), "STALE");
    assert.ok(planConsumerUpdate({ projectRoot: a, coreRoot: core }).plannedGeneratorIds.includes("project-context/architecture"));
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("init reports the derived consumer lifecycle after creating a lock", async () => {
  const a = consumer("consumer-a");
  try {
    const result = await dispatchCli({ argv: ["init", "--project", a, "--no-generate"], cwd: core, executablePath: join(core, "cli/index.ts") });
    assert.equal((result.data as { lifecycleState?: string }).lifecycleState, "RESOLVED");
    assert.equal(state(a), "RESOLVED");
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test("moving a consumer keeps its portable lock and derived identity state", () => {
  const a = consumer("consumer-a");
  const moved = join(temporaryDirectory("paved-moved"), "consumer");
  try {
    initializeConsumer(core, a, "consumer-a");
    cpSync(a, moved, { recursive: true });
    assert.equal(state(a), "RESOLVED");
    assert.equal(state(moved), "RESOLVED");
    assert.equal(readFileSync(join(a, ".paved/paved.lock")).equals(readFileSync(join(moved, ".paved/paved.lock"))), true);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});
