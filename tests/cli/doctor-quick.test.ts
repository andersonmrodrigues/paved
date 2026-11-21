import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initializeConsumer, runGenerators } from "../../cli/lib/generator-runtime.ts";
import { diagnoseQuick } from "../../cli/lib/doctor-quick.ts";

const coreRoot = join(import.meta.dirname, "../..");
const version = readFileSync(join(coreRoot, "VERSION"), "utf8").trim();
function project(run: (root: string) => void): void {
  const root = join(coreRoot, `.doctor-quick-test-${randomUUID()}`);
  mkdirSync(root);
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function initialize(root: string): void {
  writeFileSync(join(root, "README.md"), "# Example\n");
  initializeConsumer(coreRoot, root, "example");
  runGenerators(coreRoot, root, { generators: ["project-context/architecture"] });
}
function snapshot(root: string): string {
  const hash = createHash("sha256");
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(readFileSync(path));
    }
  }
  walk(root);
  return hash.digest("hex");
}
const diagnose = (projectRoot: string, launcherCoreVersion: string | undefined = version) =>
  diagnoseQuick({ projectRoot, coreRoot, launcherCoreVersion });

test("reports uninitialized without modifying the repository", () => project((root) => {
  const before = snapshot(root);
  assert.equal(diagnose(root).status, "uninitialized");
  assert.equal(snapshot(root), before);
}));

test("reports healthy generated context and a checked launcher", () => project((root) => {
  initialize(root);
  const before = snapshot(root);
  const result = diagnose(root);
  assert.equal(result.status, "healthy", JSON.stringify(result));
  assert.equal(result.context, "no-drift-detected");
  assert.equal(result.updateCheck, "current");
  assert.equal(snapshot(root), before);
}));

test("reports newer launcher only, without prescribing an update", () => project((root) => {
  initialize(root);
  const before = snapshot(root);
  const result = diagnose(root, "9999.0.0");
  assert.equal(result.status, "outdated");
  assert.deepEqual(result.update, { pinnedVersion: version, availableVersion: "9999.0.0" });
  assert.doesNotMatch(JSON.stringify(result), /run paved update/i);
  assert.equal(snapshot(root), before);
  assert.equal(diagnose(root, "0.0.0").updateCheck, "current");
}));

test("surfaces changed and newly relevant sources from existing drift inspection", () => project((root) => {
  initialize(root);
  writeFileSync(join(root, "README.md"), "# Changed\n");
  writeFileSync(join(root, "package.json"), '{"name":"example"}\n');
  const before = snapshot(root);
  const result = diagnose(root);
  assert.equal(result.status, "stale-context", JSON.stringify(result));
  assert.equal(result.context, "stale");
  assert.ok(result.staleGenerators.length > 0);
  assert.equal(snapshot(root), before);
}));

test("reports missing or malformed launcher version as unverified, not healthy", () => project((root) => {
  initialize(root);
  const absent = diagnoseQuick({ projectRoot: root, coreRoot });
  assert.equal(absent.status, "unknown");
  assert.equal(absent.updateCheck, "unavailable");
  const invalid = diagnose(root, "garbage");
  assert.equal(invalid.status, "unknown");
  assert.equal(invalid.updateCheck, "invalid");
}));

test("does not claim context is healthy without recorded generation", () => project((root) => {
  writeFileSync(join(root, "README.md"), "# Example\n");
  initializeConsumer(coreRoot, root, "example");
  const result = diagnose(root);
  assert.equal(result.status, "unknown");
  assert.equal(result.context, "unavailable");
}));

test("retains conflicts even when a newer launcher is available", () => project((root) => {
  initialize(root);
  const statePath = join(root, ".paved/generated/state/last-run.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.executions[0].status = "conflict";
  writeFileSync(statePath, JSON.stringify(state));
  const result = diagnose(root, "9999.0.0");
  assert.equal(result.status, "conflict", JSON.stringify(result));
  assert.ok(result.diagnostics.some((item) => item.category === "conflict"));
  assert.equal(result.updateCheck, "available");
}));

test("retains broken and partially initialized states", () => project((root) => {
  mkdirSync(join(root, ".paved"));
  assert.equal(diagnose(root).status, "broken");
  writeFileSync(join(root, ".paved/manifest.yaml"), "not: [valid");
  const result = diagnose(root, "9999.0.0");
  assert.equal(result.status, "broken", JSON.stringify(result));
}));

test("does not claim healthy when generated context has lost its provenance", () => project((root) => {
  initialize(root);
  writeFileSync(join(root, ".paved/project/architecture/overview.md"), "# Human content without provenance\n");
  const result = diagnose(root);
  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.context, "unavailable");
}));

test("does not claim healthy when generation state is unreadable", () => project((root) => {
  initialize(root);
  writeFileSync(join(root, ".paved/generated/state/last-run.json"), "not json");
  const result = diagnose(root);
  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.context, "unavailable");
}));

test("preserves detected drift when an update is also available", () => project((root) => {
  initialize(root);
  writeFileSync(join(root, "README.md"), "# Changed\n");
  const result = diagnose(root, "9999.0.0");
  assert.equal(result.status, "outdated");
  assert.equal(result.context, "stale");
  assert.ok(result.staleGenerators.includes("project-context/architecture"));
}));

test("reports provenance tampering as a conflict", () => project((root) => {
  initialize(root);
  const output = join(root, ".paved/project/architecture/overview.md");
  writeFileSync(output, `${readFileSync(output, "utf8")}\nHuman edit\n`);
  const result = diagnose(root, "9999.0.0");
  assert.equal(result.status, "conflict");
  assert.ok(result.diagnostics.some((item) => item.code === "PAVED_GENERATED_PROVENANCE_TAMPERED"));
}));
