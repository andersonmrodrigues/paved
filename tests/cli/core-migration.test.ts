import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { dispatchCli } from "../../cli/runtime.ts";
import {
  applyV2ToV3Migration,
  planV2ToV3Migration,
  V2_TO_V3_MIGRATION_READY,
  V2_TO_V3_MIGRATION_READY_CONTENT,
} from "../../cli/lib/core-migration.ts";
import { initializeConsumer, planConsumerInitialization } from "../../cli/lib/generator-runtime.ts";
import { ensureModelsConfig } from "../../cli/lib/models-config.ts";
import { planConsumerUpdate } from "../../cli/lib/consumer-state.ts";
import { applyConsumerUpdate } from "../../cli/lib/update-transaction.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const work = join(root, "tests/.work/core-migration");

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function setupConsumer(): string {
  const project = join(work, "consumer");
  mkdirSync(join(project, ".paved/generated/runs"), { recursive: true });
  return project;
}

function readyMigrationCore(): string {
  const coreRoot = join(work, "ready-core");
  const marker = join(coreRoot, V2_TO_V3_MIGRATION_READY);
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, `${V2_TO_V3_MIGRATION_READY_CONTENT}\n`);
  return coreRoot;
}

function copyCoreForV3(): string {
  const fakeCore = join(work, "core");
  mkdirSync(fakeCore, { recursive: true });
  for (const entry of ["VERSION", "manifest.yaml", "package.json", "adapters", "cli", "core", "generators", "schemas"]) {
    cpSync(join(root, entry), join(fakeCore, entry), { recursive: true });
  }
  rmSync(join(fakeCore, V2_TO_V3_MIGRATION_READY), { force: true });
  writeFileSync(join(fakeCore, "VERSION"), "3.0.0\n");
  const manifestPath = join(fakeCore, "manifest.yaml");
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/^version: .+$/m, "version: 3.0.0"));
  return fakeCore;
}

function markV3MigrationReady(coreRoot: string): void {
  const marker = join(coreRoot, V2_TO_V3_MIGRATION_READY);
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, `${V2_TO_V3_MIGRATION_READY_CONTENT}\n`);
}

test("v2 to v3 plans a core-range update and archives run records without changing their content", () => {
  const project = setupConsumer();
  const manifest = [
    "apiVersion: paved/v1",
    "kind: Project",
    "project:",
    "  name: sample",
    "paved:",
    "  core: ^2.30.0 # human constraint",
    "custom:",
    "  note: keep-this",
    "",
  ].join("\n");
  const run = "apiVersion: paved/v1\nkind: WorkflowRun\nid: legacy-run\nphases: []\n";
  writeFileSync(join(project, ".paved/manifest.yaml"), manifest);
  writeFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), run);
  const approval = "human-owned approval stays unchanged\n";
  const rule = "human-owned project rule stays unchanged\n";
  mkdirSync(join(project, ".paved/approvals"), { recursive: true });
  mkdirSync(join(project, ".paved/rules"), { recursive: true });
  writeFileSync(join(project, ".paved/approvals/delivery.yaml"), approval);
  writeFileSync(join(project, ".paved/rules/local.yaml"), rule);

  const plan = planV2ToV3Migration(project, "2.30.0", "3.0.0", readyMigrationCore());
  assert.deepEqual(plan, {
    fromVersion: "2.30.0",
    toVersion: "3.0.0",
    previousCoreRange: "^2.30.0",
    nextCoreRange: "^3.0.0",
    adapterRangeUpdates: [],
    archivedRunFiles: [".paved/archive/v2/generated/runs/legacy-run.yaml"],
  });

  applyV2ToV3Migration(project, plan!);

  const migrated = parse(readFileSync(join(project, ".paved/manifest.yaml"), "utf8")) as {
    paved: { core: string };
    custom: { note: string };
  };
  assert.equal(migrated.paved.core, "^3.0.0");
  assert.equal(migrated.custom.note, "keep-this");
  assert.match(readFileSync(join(project, ".paved/manifest.yaml"), "utf8"), /core: \^3\.0\.0 # human constraint/);
  assert.equal(readFileSync(join(project, ".paved/archive/v2/generated/runs/legacy-run.yaml"), "utf8"), run);
  assert.equal(existsSync(join(project, ".paved/generated/runs/legacy-run.yaml")), false);
  assert.equal(readFileSync(join(project, ".paved/approvals/delivery.yaml"), "utf8"), approval);
  assert.equal(readFileSync(join(project, ".paved/rules/local.yaml"), "utf8"), rule);
});

test("v2 to v3 updates stale bundled adapter ranges and preserves custom selections", () => {
  const project = setupConsumer();
  const core = copyCoreForV3();
  markV3MigrationReady(core);
  writeFileSync(join(project, ".paved/manifest.yaml"), [
    "apiVersion: paved/v1",
    "kind: Project",
    "paved:",
    "  core: ^2.30.0",
    "adapters:",
    "  - id: technology/java",
    "    version: ^0.1.0",
    "  - id: custom/local",
    "    version: ~1.4.0",
    "",
  ].join("\n"));

  const migration = planV2ToV3Migration(project, "2.30.0", "3.0.0", core);
  assert.deepEqual(migration?.adapterRangeUpdates, [{
    id: "technology/java",
    previousRange: "^0.1.0",
    nextRange: "^0.2.0",
  }]);

  applyV2ToV3Migration(project, migration!);
  const migrated = parse(readFileSync(join(project, ".paved/manifest.yaml"), "utf8")) as {
    adapters: { id: string; version: string }[];
  };
  assert.deepEqual(migrated.adapters, [
    { id: "technology/java", version: "^0.2.0" },
    { id: "custom/local", version: "~1.4.0" },
  ]);
});

test("v2 to v3 preflight rejects duplicate bundled adapter selections that need migration", () => {
  const project = setupConsumer();
  const core = copyCoreForV3();
  markV3MigrationReady(core);
  writeFileSync(join(project, ".paved/manifest.yaml"), [
    "apiVersion: paved/v1",
    "kind: Project",
    "paved:",
    "  core: ^2.30.0",
    "adapters:",
    "  - id: technology/java",
    "    version: ^0.1.0",
    "  - id: technology/java",
    "    version: ^0.2.0",
    "",
  ].join("\n"));

  assert.throws(
    () => planV2ToV3Migration(project, "2.30.0", "3.0.0", core),
    /duplicate adapter selection technology\/java/i,
  );
});

test("v2 to v3 preflight resolves adapters with the planned migrated ranges", () => {
  const project = join(work, "adapter-upgrade-consumer");
  const core = copyCoreForV3();
  markV3MigrationReady(core);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Adapter migration consumer\n");
  writeFileSync(join(project, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  initializeConsumer(root, project, "adapter-migration-consumer");
  const manifestPath = join(project, ".paved/manifest.yaml");
  const manifest = parse(readFileSync(manifestPath, "utf8")) as {
    adapters: { id: string; version: string }[];
  };
  manifest.adapters = [{ id: "technology/java", version: "^0.1.0" }];
  writeFileSync(manifestPath, stringify(manifest));

  const plan = planConsumerUpdate({ projectRoot: project, coreRoot: core });
  assert.equal(plan.compatibility, "compatible");
  assert.ok(plan.resolvedAdapters.includes("technology/java"));
  assert.deepEqual(plan.coreMigration?.adapterRangeUpdates, [{
    id: "technology/java",
    previousRange: "^0.1.0",
    nextRange: "^0.2.0",
  }]);
  assert.ok(!plan.diagnostics.some((item) => item.code === "PAVED_ADAPTER_INCOMPATIBLE"));
});

test("v2 to v3 refuses archive conflicts without removing legacy runs", () => {
  const project = setupConsumer();
  writeFileSync(join(project, ".paved/manifest.yaml"), "apiVersion: paved/v1\nkind: Project\npaved:\n  core: ^2.30.0\n");
  writeFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), "old run");
  mkdirSync(join(project, ".paved/archive/v2/generated/runs"), { recursive: true });
  writeFileSync(join(project, ".paved/archive/v2/generated/runs/legacy-run.yaml"), "different archived run");

  assert.throws(() => planV2ToV3Migration(project, "2.30.0", "3.0.0", readyMigrationCore()), /archive.*conflict/i);
  assert.equal(readFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), "utf8"), "old run");
  assert.equal(readFileSync(join(project, ".paved/archive/v2/generated/runs/legacy-run.yaml"), "utf8"), "different archived run");
});

test("failed staged v2-to-v3 migration leaves the authoritative run and manifest untouched", () => {
  const project = setupConsumer();
  const manifest = "apiVersion: paved/v1\nkind: Project\npaved:\n  core: ^2.30.0\n";
  const run = "preserve this legacy run exactly\n";
  writeFileSync(join(project, ".paved/manifest.yaml"), manifest);
  writeFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), run);
  const migration = planV2ToV3Migration(project, "2.30.0", "3.0.0", readyMigrationCore());

  assert.throws(() => applyConsumerUpdate(project, (staged) => {
    applyV2ToV3Migration(staged, migration!);
    throw new Error("staged validation failed");
  }), /staged validation failed/);
  assert.equal(readFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), "utf8"), run);
  assert.equal(readFileSync(join(project, ".paved/manifest.yaml"), "utf8"), manifest);
  assert.equal(existsSync(join(project, ".paved/archive/v2/generated/runs/legacy-run.yaml")), false);
});

test("models config uses only the known session capability and is never rewritten over human preferences", () => {
  const project = setupConsumer();
  const created = ensureModelsConfig(project);
  const path = join(project, ".paved/models.yaml");
  assert.equal(created, true);
  const generated = readFileSync(path, "utf8");
  assert.match(generated, /explorer:\s*\[session\]/);
  assert.match(generated, /implementer:\s*\[session\]/);
  assert.match(generated, /reviewer:\s*\[session\]/);
  assert.match(generated, /mechanical:\s*\[session\]/);
  assert.doesNotMatch(generated, /haiku|sonnet|opus|gpt|gemini/i);

  const humanConfig = [
    "roles:",
    "  implementer:",
    "    - human-selected-model",
    "  reviewer:",
    "    - session",
    "",
  ].join("\n");
  writeFileSync(path, humanConfig);
  assert.equal(ensureModelsConfig(project), false);
  assert.equal(readFileSync(path, "utf8"), humanConfig);
});

test("v2 to v3 does not claim migration support for unrelated major transitions", () => {
  const project = setupConsumer();
  const coreRoot = readyMigrationCore();
  assert.equal(planV2ToV3Migration(project, "1.9.0", "3.0.0", coreRoot), undefined);
  assert.equal(planV2ToV3Migration(project, "2.30.0", "2.31.0", coreRoot), undefined);
  assert.equal(planV2ToV3Migration(project, "2.30.0", "3.0.0", join(work, "unready-core")), undefined);
  const incompleteCore = join(work, "incomplete-core");
  const incompleteMarker = join(incompleteCore, V2_TO_V3_MIGRATION_READY);
  mkdirSync(join(incompleteMarker, ".."), { recursive: true });
  writeFileSync(incompleteMarker, "not-yet-verified\n");
  assert.equal(planV2ToV3Migration(project, "2.30.0", "3.0.0", incompleteCore), undefined);
  assert.equal(planV2ToV3Migration(project, "2.30.0", "2.30.0", root), undefined);
});

test("current Core 2.30.0 keeps legacy runs in place and does not plan a v3 archive", () => {
  const project = join(work, "current-v2-consumer");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Current Core consumer\n");
  initializeConsumer(root, project, "current-v2-consumer");
  const run = join(project, ".paved/generated/runs/legacy-run.yaml");
  mkdirSync(join(project, ".paved/generated/runs"), { recursive: true });
  writeFileSync(run, "legacy data\n");

  const plan = planConsumerUpdate({ projectRoot: project, coreRoot: root });
  assert.equal(plan.currentLock?.core?.version, "2.30.0");
  assert.equal(plan.coreMigration, undefined);
  assert.ok(!plan.plannedWrites.some((path) => path.startsWith(".paved/archive/v2/")));
  assert.equal(readFileSync(run, "utf8"), "legacy data\n");
});

test("update refuses to archive v2 runs until the v3 routing-and-gates readiness marker exists", async () => {
  const project = join(work, "upgrade-consumer");
  const fakeCore = copyCoreForV3();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Migration consumer\n");
  initializeConsumer(root, project, "migration-consumer");
  const run = "apiVersion: paved/v1\nkind: WorkflowRun\nid: legacy-run\nphases: []\n";
  mkdirSync(join(project, ".paved/generated/runs"), { recursive: true });
  writeFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), run);

  const plan = planConsumerUpdate({ projectRoot: project, coreRoot: fakeCore });
  assert.equal(plan.compatibility, "incompatible");
  assert.equal(plan.coreMigration, undefined);
  const manifestBefore = readFileSync(join(project, ".paved/manifest.yaml"));
  const lockBefore = readFileSync(join(project, ".paved/paved.lock"));
  const modelsBefore = readFileSync(join(project, ".paved/models.yaml"));

  const result = await dispatchCli({
    argv: ["update", "--project", project, "--json"],
    cwd: root,
    executablePath: join(fakeCore, "cli/index.ts"),
  });
  assert.equal(result.status, "failed", JSON.stringify(result));
  assert.equal(readFileSync(join(project, ".paved/generated/runs/legacy-run.yaml"), "utf8"), run);
  assert.equal(existsSync(join(project, ".paved/archive/v2/generated/runs/legacy-run.yaml")), false);
  assert.equal(readFileSync(join(project, ".paved/manifest.yaml")).equals(manifestBefore), true);
  assert.equal(readFileSync(join(project, ".paved/paved.lock")).equals(lockBefore), true);
  assert.equal(readFileSync(join(project, ".paved/models.yaml")).equals(modelsBefore), true);
});

test("init and update create models.yaml only when absent and preserve existing preferences", async () => {
  const project = join(work, "models-consumer");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Models consumer\n");
  const initialization = planConsumerInitialization(root, project, "models-consumer");
  assert.ok(initialization.plannedWrites.includes(".paved/models.yaml"));
  initializeConsumer(root, project, "models-consumer");
  const path = join(project, ".paved/models.yaml");
  assert.equal(existsSync(path), true);

  const humanConfig = "roles:\n  implementer: [human-model]\n";
  writeFileSync(path, humanConfig);
  const unchanged = planConsumerUpdate({ projectRoot: project, coreRoot: root });
  assert.ok(!unchanged.plannedWrites.includes(".paved/models.yaml"));
  const noOp = await dispatchCli({ argv: ["update", "--project", project, "--json"], cwd: root });
  assert.notEqual(noOp.status, "failed", JSON.stringify(noOp.diagnostics));
  assert.equal(readFileSync(path, "utf8"), humanConfig);

  rmSync(path);
  const missing = planConsumerUpdate({ projectRoot: project, coreRoot: root });
  assert.equal(missing.changed, true);
  assert.ok(missing.plannedWrites.includes(".paved/models.yaml"));
  const refreshed = await dispatchCli({ argv: ["update", "--project", project, "--json"], cwd: root });
  assert.notEqual(refreshed.status, "failed", JSON.stringify(refreshed.diagnostics));
  assert.match(readFileSync(path, "utf8"), /implementer: \[session\]/);
});
