import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { initializeConsumer, runGenerators } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
afterEach(cleanupTemporaryDirectories);

function write(root: string, file: string, data: unknown): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(data));
}

it("returns the feature and applicable project rules for a path", async () => {
  const project = temporaryDirectory("paved-context");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Project" });
  write(project, ".paved/project/feature-map/auth.yaml", {
    apiVersion: "paved/v1", kind: "Feature", id: "authentication", name: "Authentication",
    summary: "Signing in.", status: "active", confidence: "unknown", code: { paths: ["src/auth/**"] },
  });

  write(project, ".paved/project/feature-map/reports.yaml", {
    apiVersion: "paved/v1", kind: "Feature", id: "reports", name: "Reports",
    summary: "Reports.", status: "active", confidence: "unknown", code: { paths: ["src/reports/**"] },
  });
  write(project, ".paved/rules/auth.yaml", {
    kind: "Rule", id: "project.auth", title: "Protect login", rule: "Check authorization.",
    applies_to: { paths: ["src/auth/**"] },
  });
  write(project, ".paved/rules/reports.yaml", {
    kind: "Rule", id: "project.reports", title: "Reports", rule: "Check report formatting.",
    applies_to: { paths: ["src/reports/**"] },
  });

  const result = await dispatchCli({ argv: ["context", "src/auth/login.ts", "--project", project], cwd: ROOT, executablePath: join(ROOT, "cli/index.ts") });

  assert.equal(result.status, "success", JSON.stringify(result));
  const context = (result.data as { context: string }).context;
  assert.match(context, /authentication/i);
  assert.match(context, /Check authorization/);
  assert.doesNotMatch(context, /Check report formatting|Reports\./);

  const byTopic = await dispatchCli({ argv: ["context", "authentication", "--project", project], cwd: ROOT, executablePath: join(ROOT, "cli/index.ts") });
  assert.match((byTopic.data as { context: string }).context, /Check authorization/);
});

it("reports truncation and never exceeds the requested budget", async () => {
  const project = temporaryDirectory("paved-context-budget");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Project" });
  write(project, ".paved/rules/auth.yaml", {
    kind: "Rule", id: "project.auth", title: "Protect login",
    rule: "Check authorization before granting access.", applies_to: { paths: ["src/auth/**"] },
  });

  const result = await dispatchCli({
    argv: ["context", "src/auth/login.ts", "--project", project, "--budget", "20"],
    cwd: ROOT, executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal(result.status, "success", JSON.stringify(result));
  const data = result.data as { context: string; truncated: boolean };
  assert.equal(data.truncated, true);
  assert.ok(Buffer.byteLength(data.context, "utf8") <= 20);
});

it("prioritizes project rules over feature summaries when the budget is limited", async () => {
  const project = temporaryDirectory("paved-context-priority");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Project" });
  write(project, ".paved/project/feature-map/auth.yaml", {
    kind: "Feature", id: "authentication", name: "Authentication",
    summary: "Long context. ".repeat(30), code: { paths: ["src/auth/**"] },
  });
  write(project, ".paved/rules/auth.yaml", {
    kind: "Rule", id: "project.auth", title: "Protect login",
    rule: "Check authorization.", applies_to: { paths: ["src/auth/**"] },
  });
  const result = await dispatchCli({
    argv: ["context", "src/auth/login.ts", "--project", project, "--budget", "180"],
    cwd: ROOT, executablePath: join(ROOT, "cli/index.ts"),
  });
  assert.equal(result.status, "success");
  const data = result.data as { context: string; truncated: boolean };
  assert.match(data.context, /Check authorization/);
  assert.equal(data.truncated, true);
});

it("refuses a feature-map directory symlink", async () => {
  const project = temporaryDirectory("paved-context-link");
  const outside = temporaryDirectory("paved-context-outside");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Project" });
  mkdirSync(join(project, ".paved/project"), { recursive: true });
  symlinkSync(outside, join(project, ".paved/project/feature-map"));
  write(outside, "secret.yaml", {
    kind: "Feature", id: "secret", name: "Secret", summary: "Private content",
    code: { paths: ["src/**"] },
  });

  const result = await dispatchCli({
    argv: ["context", "src/index.ts", "--project", project], cwd: ROOT, executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /Private content/);
});

it("refreshes the requested context area and its required generators only", async () => {
  const project = temporaryDirectory("paved-context-refresh");
  writeFileSync(join(project, "README.md"), "# Example\n");
  mkdirSync(join(project, "web/src"), { recursive: true });
  writeFileSync(join(project, "web/package.json"), JSON.stringify({
    name: "example", dependencies: { "@angular/core": "^19.2.15" },
  }));
  writeFileSync(join(project, "web/angular.json"), '{"projects":{}}');
  writeFileSync(join(project, "web/tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  writeFileSync(join(project, "web/src/app-routing.module.ts"), "const routes = [{ path: 'courses', component: CoursesPage }];\n");
  initializeConsumer(ROOT, project, "example");
  assert.deepEqual(runGenerators(ROOT, project).errors, []);

  const architecturePath = join(project, ".paved/project/architecture/overview.md");
  const domainPath = join(project, ".paved/project/domain/overview.md");
  const featureMapPath = join(project, ".paved/project/feature-map/web-courses.yaml");
  const architectureBefore = readFileSync(architecturePath, "utf8");
  const domainBefore = readFileSync(domainPath, "utf8");
  const featureMapBefore = readFileSync(featureMapPath, "utf8");
  writeFileSync(join(project, "README.md"), "# Updated Example\n");

  const result = await dispatchCli({
    argv: ["context", "refresh", "--areas", "domain", "--project", project],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual((result.data as { areas: string[] }).areas, ["domain"]);
  assert.notEqual(readFileSync(architecturePath, "utf8"), architectureBefore);
  assert.notEqual(readFileSync(domainPath, "utf8"), domainBefore);
  assert.equal(readFileSync(featureMapPath, "utf8"), featureMapBefore);
  const generation = (result.data as { generation: { executions: { generator: string }[] } }).generation;
  assert.deepEqual(generation.executions.map((execution) => execution.generator), [
    "project-context/architecture",
    "project-context/domain",
  ]);
  assert.deepEqual((result.data as { changedFiles: string[] }).changedFiles, [
    ".paved/project/architecture/overview.md",
    ".paved/project/domain/overview.md",
  ]);
});

it("refreshes only detected stale areas when no areas are named", async () => {
  const project = temporaryDirectory("paved-context-stale");
  writeFileSync(join(project, "README.md"), "# Example\n");
  mkdirSync(join(project, "web/src"), { recursive: true });
  writeFileSync(join(project, "web/package.json"), JSON.stringify({
    name: "example", dependencies: { "@angular/core": "^19.2.15" },
  }));
  writeFileSync(join(project, "web/angular.json"), '{"projects":{}}');
  writeFileSync(join(project, "web/tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  writeFileSync(join(project, "web/src/app-routing.module.ts"), "const routes = [{ path: 'courses', component: CoursesPage }];\n");
  initializeConsumer(ROOT, project, "example");
  assert.deepEqual(runGenerators(ROOT, project).errors, []);
  const featureMapPath = join(project, ".paved/project/feature-map/web-courses.yaml");
  const featureMapBefore = readFileSync(featureMapPath, "utf8");
  writeFileSync(join(project, "README.md"), "# Updated Example\n");

  const result = await dispatchCli({
    argv: ["context", "refresh", "--project", project],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal(result.status, "success", JSON.stringify(result));
  const data = result.data as { areas: string[]; generation: { executions: { generator: string }[] } };
  assert.deepEqual(data.areas, ["project-context/architecture", "project-context/domain", "project-context/product"]);
  assert.deepEqual(data.generation.executions.map((execution) => execution.generator), data.areas);
  assert.equal(readFileSync(featureMapPath, "utf8"), featureMapBefore);

  const unchanged = await dispatchCli({
    argv: ["context", "refresh", "--project", project],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });
  assert.equal(unchanged.status, "success", JSON.stringify(unchanged));
  assert.deepEqual((unchanged.data as { changedFiles: string[] }).changedFiles, []);
});

it("rejects unknown context areas without generating anything", async () => {
  const project = temporaryDirectory("paved-context-unknown");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Project" });

  const result = await dispatchCli({
    argv: ["context", "refresh", "--areas", "north", "--project", project],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0]?.code, "PAVED_CONTEXT_AREA_UNKNOWN");
});

it("requires explicit areas when generation evidence cannot identify stale context", async () => {
  const project = temporaryDirectory("paved-context-unknown-state");
  write(project, ".paved/manifest.yaml", { apiVersion: "paved/v1", kind: "Project" });

  const result = await dispatchCli({
    argv: ["context", "refresh", "--project", project],
    cwd: ROOT,
    executablePath: join(ROOT, "cli/index.ts"),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0]?.code, "PAVED_CONTEXT_REFRESH_STATE_UNKNOWN");
});
