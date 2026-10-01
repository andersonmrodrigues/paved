import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { CORE_VERSION, treeIntegrity } from "../helpers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("project-local agent bootstrap", () => {
  it("acquires a verified packed runtime, initializes, reuses it offline, and rejects corruption", () => {
    const workspace = mkdtempSync(join(tmpdir(), "paved-bootstrap-"));
    try {
      const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", workspace, "--json"], {
        cwd: root, encoding: "utf8", shell: false,
      });
      assert.equal(packed.status, 0, packed.stderr);
      const [artifact] = JSON.parse(packed.stdout) as { filename: string; integrity: string }[];
      assert.ok(artifact);
      const consumer = join(workspace, "consumer");
      const integration = join(consumer, ".agents", "skills", "paved-runtime");
      mkdirSync(consumer);
      writeFileSync(join(consumer, "README.md"), "# Clean consumer\n");
      writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "clean-consumer", private: true, type: "module" }));
      mkdirSync(join(consumer, "src"));
      writeFileSync(join(consumer, "src", "feature.js"), "export const enabled = false;\n");
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: consumer }).status, 0);
      assert.equal(spawnSync("git", ["add", "README.md", "package.json", "src/feature.js"], { cwd: consumer }).status, 0);
      assert.equal(spawnSync("git", ["-c", "user.name=Paved Test", "-c", "user.email=paved@example.invalid", "commit", "-qm", "baseline"], { cwd: consumer }).status, 0);
      const installer = join(workspace, "installer");
      const installed = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-bin-links", "--prefix", installer, join(workspace, artifact.filename)], {
        cwd: workspace, encoding: "utf8", shell: false,
      });
      assert.equal(installed.status, 0, installed.stderr);
      const packagedExecutable = join(installer, "node_modules", "paved-core", "cli", "build", "cli", "index.js");
      const projection = spawnSync(process.execPath, [packagedExecutable, "agent", "install", "codex", "--project", consumer, "--json"], {
        cwd: workspace, encoding: "utf8", shell: false,
      });
      assert.equal(projection.status, 0, projection.stdout + projection.stderr);
      assert.equal(existsSync(join(integration, "bootstrap.mjs")), true);
      rmSync(installer, { recursive: true, force: true });
      const rejectedConsumer = join(workspace, "rejected-consumer");
      const rejectedIntegration = join(rejectedConsumer, ".agents", "skills", "paved-runtime");
      mkdirSync(join(rejectedConsumer, ".agents", "skills"), { recursive: true });
      cpSync(integration, rejectedIntegration, { recursive: true });
      const rejectInvoke = () => spawnSync(process.execPath, [join(rejectedIntegration, "bootstrap.mjs"), "--version", "--json"], {
        cwd: rejectedConsumer, encoding: "utf8", shell: false, env: { ...process.env, npm_config_offline: "true" },
      });
      writeFileSync(join(rejectedIntegration, "bootstrap.json"), JSON.stringify({
        package: "paved-core", version: CORE_VERSION, integrity: "sha512-AAAA", tarball: join(workspace, artifact.filename),
      }));
      assert.equal((JSON.parse(rejectInvoke().stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_INTEGRITY_MISMATCH");
      writeFileSync(join(rejectedIntegration, "bootstrap.json"), JSON.stringify({
        package: "paved-core", version: "9.9.9", integrity: artifact.integrity, tarball: join(workspace, artifact.filename),
      }));
      assert.equal((JSON.parse(rejectInvoke().stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_VERSION_MISMATCH");
      writeFileSync(join(rejectedIntegration, "bootstrap.json"), JSON.stringify({
        package: "paved-core", version: CORE_VERSION, integrity: artifact.integrity, tarball: join(workspace, artifact.filename),
      }));
      mkdirSync(join(rejectedConsumer, ".paved", "runtime", ".bootstrap-lock"), { recursive: true });
      assert.equal((JSON.parse(rejectInvoke().stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_CONCURRENT_BOOTSTRAP");
      rmSync(join(rejectedConsumer, ".paved"), { recursive: true, force: true });
      const outsider = join(workspace, "outsider");
      mkdirSync(outsider);
      writeFileSync(join(outsider, "protected.txt"), "untouched\n");
      symlinkSync(outsider, join(rejectedConsumer, ".paved"));
      assert.equal((JSON.parse(rejectInvoke().stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_SYMLINK");
      assert.equal(readFileSync(join(outsider, "protected.txt"), "utf8"), "untouched\n");
      rmSync(join(rejectedConsumer, ".paved"));
      symlinkSync(join(workspace, "missing-target"), join(rejectedConsumer, ".paved"));
      assert.equal((JSON.parse(rejectInvoke().stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_SYMLINK");
      writeFileSync(join(integration, "bootstrap.json"), JSON.stringify({
        package: "paved-core", version: CORE_VERSION, integrity: artifact.integrity,
        tarball: join(workspace, artifact.filename),
      }));
      const invoke = (...args: string[]) => spawnSync(process.execPath, [join(integration, "bootstrap.mjs"), ...args], {
        cwd: consumer, encoding: "utf8", shell: false, env: { ...process.env, npm_config_offline: "true" },
      });
      const initialized = invoke("init", "--json");
      assert.ok(initialized.status === 0 || initialized.status === 1, initialized.stdout + initialized.stderr);
      const initResult = JSON.parse(initialized.stdout) as { data?: { initialized?: boolean } };
      assert.equal(initResult.data?.initialized, true);
      const lock = parse(readFileSync(join(consumer, ".paved", "paved.lock"), "utf8")) as {
        runtime: { package: string; version: string; integrity: string; content_sha256: string };
      };
      assert.equal(lock.runtime.package, "paved-core");
      assert.equal(lock.runtime.version, CORE_VERSION);
      assert.equal(lock.runtime.integrity, artifact.integrity);
      const selection = JSON.parse(readFileSync(join(consumer, ".paved", "runtime", "selection.json"), "utf8")) as { directory: string };
      const activePackage = join(consumer, ".paved", "runtime", "versions", selection.directory, "node_modules", "paved-core");
      assert.equal(existsSync(join(activePackage, "cli", "build", "cli", "index.js")), true);
      assert.notEqual(activePackage, root);
      const status = invoke("status", "--json");
      assert.ok(status.status === 0 || status.status === 1, readFileSync(join(consumer, ".paved", "paved.lock"), "utf8") + status.stdout + status.stderr);
      const result = JSON.parse(status.stdout) as { data?: { coreRoot?: string } };
      assert.equal(result.data?.coreRoot, realpathSync(activePackage));
      const commands = invoke("agent", "commands", "--json");
      assert.equal(commands.status, 0, commands.stdout + commands.stderr);
      assert.equal((JSON.parse(commands.stdout) as { data?: { commands: unknown[] } }).data?.commands.length, 15);

      mkdirSync(join(consumer, ".paved", "tools"), { recursive: true });
      mkdirSync(join(consumer, ".paved", "tool-implementations"), { recursive: true });
      mkdirSync(join(consumer, ".paved", "verification", "checks"), { recursive: true });
      const tool = parse(readFileSync(join(activePackage, "core", "tools", "testing", "run.yaml"), "utf8")) as Record<string, unknown>;
      tool.id = "project.testing.run";
      writeFileSync(join(consumer, ".paved", "tools", "testing.yaml"), stringify(tool));
      writeFileSync(join(consumer, ".paved", "tool-implementations", "testing.yaml"), stringify({
        apiVersion: "paved/v1", kind: "ToolImplementation", id: "project.testing.run", tool: "project.testing.run",
        version: "1.0.0", contract: "^0.1.0", source: "project", environments: ["local"],
        invocation: { type: "command", executable: "node", arguments: ["--", ".paved/tools/test-runner.mjs"] },
        availability: "available",
      }));
      writeFileSync(join(consumer, ".paved", "tools", "feature.test.mjs"), [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { enabled } from "../../src/feature.js";',
        'test("feature is enabled", () => assert.equal(enabled, true));',
      ].join("\n"));
      writeFileSync(join(consumer, ".paved", "tools", "test-runner.mjs"), [
        'import { spawnSync } from "node:child_process";',
        'const run = spawnSync(process.execPath, ["--test", ".paved/tools/feature.test.mjs"], {cwd: process.cwd(), encoding: "utf8", shell: false});',
        'process.stdout.write(JSON.stringify({status: run.status === 0 ? "passed" : "failed", output: run.stdout ?? ""}));',
        'process.exitCode = run.status ?? 1;',
      ].join("\n"));
      writeFileSync(join(consumer, ".paved", "verification", "checks", "unit.yaml"), stringify({
        apiVersion: "paved/v1", kind: "Check", id: "project.verify.feature", title: "Feature regression",
        purpose: "Prove the approved feature behavior.", type: "unit", tool: "project.testing.run", inputs: {},
        expected: { description: "Feature test passes.", exit_code: 0 }, timeout_seconds: 10,
        environment: { kinds: ["local"] }, failure: "Feature regression failed.",
        determinism: { class: "deterministic" }, retry: { class: "non-retryable" },
      }));
      writeFileSync(join(consumer, ".paved", "verification", "profile.yaml"), stringify({
        apiVersion: "paved/v1", kind: "VerificationProfile", checks: ["project.verify.feature"], policy: { minimum_recorder: "agent" },
      }));
      const readyCommands = invoke("agent", "commands", "--json");
      assert.equal(readyCommands.status, 0, readyCommands.stdout + readyCommands.stderr);
      const ready = (JSON.parse(readyCommands.stdout) as { data: { commands: { name: string; available: boolean }[] } }).data.commands;
      assert.equal(ready.find((command) => command.name === "test")?.available, true);
      assert.equal(ready.find((command) => command.name === "feature")?.available, true);
      const started = invoke("feature", "Enable the sample feature", "--json");
      assert.equal(started.status, 0, started.stdout + started.stderr);
      const runId = (JSON.parse(started.stdout) as { data: { run: string } }).data.run;
      const advance = (...args: string[]) => invoke("feature", "--run", runId, "--advance", ...args, "--json");
      assert.equal(advance("--note", "Scope understood").status, 0);
      assert.equal(advance("--note", "Architecture inspected").status, 0);
      const planPath = join(consumer, ".paved", "generated", "plan.md");
      writeFileSync(planPath, "Enable src/feature.js and prove it with the project test.\n");
      const awaiting = advance("--note", "Concrete implementation plan", "--evidence", ".paved/generated/plan.md");
      assert.equal((JSON.parse(awaiting.stdout) as { data: { status: string } }).data.status, "awaiting-approval");
      const workflowPath = join(consumer, ".paved", "generated", "runs", `${runId}.yaml`);
      const workflow = parse(readFileSync(workflowPath, "utf8")) as { phases: { phase: string; gates?: { reason?: string }[] }[] };
      const planSha = workflow.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.reason?.startsWith("plan_sha256="))?.reason?.slice(12);
      mkdirSync(join(consumer, ".paved", "approvals"));
      writeFileSync(join(consumer, ".paved", "approvals", `${runId}.json`), JSON.stringify({
        run: runId, plan_sha256: planSha, decision: "approved", decided_by: "maintainer", decided_at: new Date().toISOString(),
      }));
      assert.equal(advance().status, 0);
      writeFileSync(join(consumer, "src", "feature.js"), "export const enabled = true;\n");
      const implemented = advance("--note", "Implemented approved behavior");
      assert.equal(implemented.status, 0, implemented.stdout + implemented.stderr);
      const tested = advance();
      assert.equal(tested.status, 0, tested.stdout + tested.stderr);
      const verified = advance();
      assert.equal(verified.status, 0, verified.stdout + verified.stderr);
      assert.equal((JSON.parse(verified.stdout) as { data: { currentPhase: string } }).data.currentPhase, "evidence");
      const verifiedRun = parse(readFileSync(workflowPath, "utf8")) as { evidence: string };
      const authoritative = parse(readFileSync(join(consumer, verifiedRun.evidence), "utf8")) as Record<string, unknown>;
      const diff = spawnSync("git", ["diff", "HEAD", "--", "src/feature.js"], { cwd: consumer, encoding: "utf8", shell: false });
      assert.equal(diff.status, 0, diff.stderr);
      const diffText = diff.stdout;
      assert.match(diffText, /\+export const enabled = true/);
      const diffRef = ".paved/generated/evidence/feature-diff.md";
      writeFileSync(join(consumer, diffRef), diffText);
      const workflowEvidence = {
        ...authoritative,
        id: "feature-evidence",
        producer: { agent: "paved-cli", workflow: "core.feature" },
        change: { ...(authoritative.change as Record<string, unknown>), summary: "Enabled the sample feature." },
        plan: { required: ["unit"], recommended: ["build", "static-analysis", "unit", "integration", "e2e"], evidence: ["check-result", "diff"] },
        artifacts: [...(authoritative.artifacts as unknown[]), {
          id: "feature-diff", kind: "diff", description: "Observed change to the feature module.",
          recorded_by: "agent", revision: (authoritative.change as { revision: string }).revision,
          created_at: new Date().toISOString(),
          source: { type: "file", location: diffRef, sha256: createHash("sha256").update(diffText).digest("hex") },
        }],
      };
      const workflowEvidenceRef = ".paved/generated/evidence/feature-evidence.yaml";
      writeFileSync(join(consumer, workflowEvidenceRef), stringify(workflowEvidence));
      const recorded = advance("--evidence", workflowEvidenceRef);
      assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
      assert.equal(advance("--note", "Reviewed the implementation and evidence").status, 0);
      const completed = advance();
      assert.equal(completed.status, 0, completed.stdout + completed.stderr);
      assert.equal((JSON.parse(completed.stdout) as { data: { status: string } }).data.status, "completed");

      const approvePlan = (command: "fix" | "refactor", runId: string, label: string) => {
        const path = join(consumer, ".paved", "generated", `${label}-plan.md`);
        writeFileSync(path, `${label} plan for src/feature.js with a governed regression test.\n`);
        const pending = invoke(command, "--run", runId, "--advance", "--note", `${label} plan`, "--evidence", `.paved/generated/${label}-plan.md`, "--json");
        assert.equal((JSON.parse(pending.stdout) as { data: { status: string } }).data.status, "awaiting-approval", pending.stdout + pending.stderr);
        const workflowPath = join(consumer, ".paved", "generated", "runs", `${runId}.yaml`);
        const workflow = parse(readFileSync(workflowPath, "utf8")) as { phases: { phase: string; gates?: { reason?: string }[] }[] };
        const planSha = workflow.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.reason?.startsWith("plan_sha256="))?.reason?.slice(12);
        writeFileSync(join(consumer, ".paved", "approvals", `${runId}.json`), JSON.stringify({
          run: runId, plan_sha256: planSha, decision: "approved", decided_by: "maintainer", decided_at: new Date().toISOString(),
        }));
      };
      const recordWorkflowEvidence = (command: "fix" | "refactor", runId: string, summary: string) => {
        const workflowPath = join(consumer, ".paved", "generated", "runs", `${runId}.yaml`);
        const state = parse(readFileSync(workflowPath, "utf8")) as { evidence: string };
        const authoritative = parse(readFileSync(join(consumer, state.evidence), "utf8")) as Record<string, unknown>;
        const diff = spawnSync("git", ["diff", "HEAD", "--", "src/feature.js"], { cwd: consumer, encoding: "utf8", shell: false });
        assert.equal(diff.status, 0, diff.stderr);
        const diffText = diff.stdout;
        assert.notEqual(diffText.trim(), "", `${command} must change the scoped source`);
        const diffRef = `.paved/generated/evidence/${command}-${runId}-diff.md`;
        writeFileSync(join(consumer, diffRef), diffText);
        const artifacts = [...(authoritative.artifacts as unknown[]), {
          id: `${command}-diff`, kind: "diff", description: `Observed ${command} change to the feature module.`,
          recorded_by: "agent", revision: (authoritative.change as { revision: string }).revision,
          created_at: new Date().toISOString(),
          source: { type: "file", location: diffRef, sha256: createHash("sha256").update(diffText).digest("hex") },
        }];
        const evidenceKinds = command === "fix" ? ["reproduction", "check-result", "diff"] : ["check-result", "diff"];
        if (command === "fix") {
          const reproductionRef = `.paved/generated/evidence/${command}-${runId}-reproduction.md`;
          writeFileSync(join(consumer, reproductionRef), "The governed regression test failed before the fix and passed after it.\n");
          artifacts.push({
            id: "fix-reproduction", kind: "reproduction", description: "Observed the regression before applying the fix.",
            recorded_by: "agent", revision: (authoritative.change as { revision: string }).revision,
            created_at: new Date().toISOString(), source: { type: "file", location: reproductionRef },
          });
        }
        const workflowEvidence = {
          ...authoritative,
          id: `${command}-${runId}-evidence`,
          producer: { agent: "paved-cli", workflow: command === "fix" ? "core.bug" : "core.refactor" },
          change: { ...(authoritative.change as Record<string, unknown>), summary },
          plan: { required: ["unit"], recommended: ["build", "static-analysis", "integration", "e2e", ...(command === "refactor" ? ["architecture"] : [])], evidence: evidenceKinds },
          artifacts,
        };
        const ref = `.paved/generated/evidence/${command}-${runId}-workflow.yaml`;
        writeFileSync(join(consumer, ref), stringify(workflowEvidence));
        return ref;
      };

      writeFileSync(join(consumer, "src", "feature.js"), "export const enabled = false;\n");
      const fixStarted = invoke("fix", "Correct the disabled feature behavior", "--json");
      assert.equal(fixStarted.status, 0, fixStarted.stdout + fixStarted.stderr);
      const fixId = (JSON.parse(fixStarted.stdout) as { data: { run: string } }).data.run;
      const reproduced = invoke("test", "--json");
      assert.notEqual(reproduced.status, 0, reproduced.stdout + reproduced.stderr);
      const reproducedEvidence = (JSON.parse(reproduced.stdout) as { data: { evidence: string } }).data.evidence;
      const advanceFix = (...args: string[]) => invoke("fix", "--run", fixId, "--advance", ...args, "--json");
      assert.equal(advanceFix("--note", "Expected behavior is enabled").status, 0);
      const confirmedCause = advanceFix("--note", "The source flag is false while the regression check expects true", "--evidence", reproducedEvidence);
      assert.equal(confirmedCause.status, 0, confirmedCause.stdout + confirmedCause.stderr);
      approvePlan("fix", fixId, "fix");
      assert.equal(advanceFix().status, 0);
      writeFileSync(join(consumer, "src", "feature.js"), "export const enabled = true;\n");
      assert.equal(advanceFix("--note", "Changed the faulty flag").status, 0);
      assert.equal(advanceFix().status, 0);
      assert.equal(advanceFix().status, 0);
      const fixEvidence = recordWorkflowEvidence("fix", fixId, "Restored the expected enabled behavior.");
      assert.equal(advanceFix("--evidence", fixEvidence).status, 0);
      assert.equal(advanceFix("--note", "Reviewed the regression and its cause").status, 0);
      const fixCompleted = advanceFix();
      assert.equal(fixCompleted.status, 0, fixCompleted.stdout + fixCompleted.stderr);
      assert.equal((JSON.parse(fixCompleted.stdout) as { data: { status: string } }).data.status, "completed");

      const baseline = invoke("test", "--json");
      assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
      const baselineEvidence = (JSON.parse(baseline.stdout) as { data: { evidence: string } }).data.evidence;
      const refactorStarted = invoke("refactor", "Extract the enabled default without changing behavior", "--json");
      assert.equal(refactorStarted.status, 0, refactorStarted.stdout + refactorStarted.stderr);
      const refactorId = (JSON.parse(refactorStarted.stdout) as { data: { run: string } }).data.run;
      const advanceRefactor = (...args: string[]) => invoke("refactor", "--run", refactorId, "--advance", ...args, "--json");
      assert.equal(advanceRefactor("--note", "Only the implementation structure should change").status, 0);
      assert.equal(advanceRefactor("--note", "Baseline governed test passes", "--evidence", baselineEvidence).status, 0);
      approvePlan("refactor", refactorId, "refactor");
      assert.equal(advanceRefactor().status, 0);
      writeFileSync(join(consumer, "src", "feature.js"), "const enabledByDefault = true;\nexport const enabled = enabledByDefault;\n");
      assert.equal(advanceRefactor("--note", "Extracted the default while preserving the exported value").status, 0);
      assert.equal(advanceRefactor().status, 0);
      assert.equal(advanceRefactor().status, 0);
      const refactorEvidence = recordWorkflowEvidence("refactor", refactorId, "Extracted a named default with unchanged behavior.");
      const refactorRecorded = advanceRefactor("--evidence", refactorEvidence);
      assert.equal(refactorRecorded.status, 0, refactorRecorded.stdout + refactorRecorded.stderr);
      assert.equal(advanceRefactor("--note", "Reviewed the diff and confirmed the exported behavior").status, 0);
      const refactorCompleted = advanceRefactor();
      assert.equal(refactorCompleted.status, 0, refactorCompleted.stdout + refactorCompleted.stderr);
      assert.equal((JSON.parse(refactorCompleted.stdout) as { data: { status: string } }).data.status, "completed");

      const finalStatus = invoke("status", "--json");
      assert.ok(finalStatus.status === 0 || finalStatus.status === 1, finalStatus.stdout + finalStatus.stderr);
      assert.ok(["VALIDATED", "READY"].includes((JSON.parse(finalStatus.stdout) as { data: { lifecycleState: string } }).data.lifecycleState));
      const bootstrapConfig = join(integration, "bootstrap.json");
      writeFileSync(bootstrapConfig, JSON.stringify({ package: "paved-core", version: "9.9.9" }));
      assert.ok([0, 1].includes(invoke("status", "--json").status ?? -1), "paved.lock must remain authoritative over a newer integration pin");
      const lockPath = join(consumer, ".paved", "paved.lock");
      const knownGoodLock = readFileSync(lockPath, "utf8");
      writeFileSync(lockPath, knownGoodLock.replace(/integrity: sha512-[A-Za-z0-9+/=]+/, "integrity: sha512-AAAA"));
      const mismatch = invoke("status", "--json");
      assert.equal((JSON.parse(mismatch.stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_LOCK_MISMATCH");
      writeFileSync(lockPath, knownGoodLock);

      const damaged = join(activePackage, "VERSION");
      writeFileSync(damaged, "tampered\n");
      const rejected = invoke("status", "--json");
      assert.equal(rejected.status, 5);
      assert.equal((JSON.parse(rejected.stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code, "PAVED_RUNTIME_CORRUPT");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("activates a bundled unpacked runtime without npm and rejects tampered trees", () => {
    const workspace = mkdtempSync(join(tmpdir(), "paved-bootstrap-tree-"));
    try {
      const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", workspace, "--json"], { cwd: root, encoding: "utf8", shell: false });
      assert.equal(packed.status, 0, packed.stderr);
      const [artifact] = JSON.parse(packed.stdout) as { filename: string }[];
      assert.equal(spawnSync("tar", ["-xzf", join(workspace, artifact!.filename), "-C", workspace]).status, 0);
      const bundled = join(workspace, "package");
      const integrity = treeIntegrity(bundled);

      const consumer = join(workspace, "consumer");
      const integration = join(consumer, ".agents", "skills", "paved-runtime");
      mkdirSync(integration, { recursive: true });
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: consumer }).status, 0);
      cpSync(join(root, "integrations", "shared", "bootstrap.mjs"), join(integration, "bootstrap.mjs"));
      const configure = (fields: Record<string, unknown>) => {
        rmSync(join(consumer, ".paved"), { recursive: true, force: true });
        writeFileSync(join(integration, "bootstrap.json"), JSON.stringify({ package: "paved-core", version: CORE_VERSION, ...fields }));
      };
      // An empty PATH proves activation never shells out to npm.
      const invoke = (...args: string[]) => spawnSync(process.execPath, [join(integration, "bootstrap.mjs"), ...args], {
        cwd: consumer, encoding: "utf8", shell: false, env: { ...process.env, PATH: "" },
      });
      const code = (result: ReturnType<typeof invoke>) => (JSON.parse(result.stdout) as { diagnostics: { code: string }[] }).diagnostics[0]?.code;
      const versions = () => join(consumer, ".paved", "runtime", "versions");
      const tampered = (name: string, change: (tree: string) => void) => {
        const tree = join(workspace, name);
        cpSync(bundled, tree, { recursive: true });
        change(tree);
        return tree;
      };

      configure({ runtime: bundled });
      assert.equal(code(invoke("--version", "--json")), "PAVED_RUNTIME_INTEGRITY_UNAVAILABLE");
      configure({ runtime: bundled, tarball: join(workspace, artifact!.filename), integrity });
      assert.equal(code(invoke("--version", "--json")), "PAVED_RUNTIME_CONFIG_INVALID");
      configure({ runtime: join(workspace, "missing"), integrity });
      assert.equal(code(invoke("--version", "--json")), "PAVED_RUNTIME_PACKAGE_UNAVAILABLE");

      configure({ runtime: tampered("edited", (tree) => writeFileSync(join(tree, "VERSION"), "tampered\n")), integrity });
      assert.equal(code(invoke("--version", "--json")), "PAVED_RUNTIME_INTEGRITY_MISMATCH");
      assert.deepEqual(readdirSync(versions()), [], "a rejected tree is never activated");
      configure({ runtime: tampered("linked", (tree) => symlinkSync(join(workspace, "outside"), join(tree, "outside"))), integrity });
      assert.equal(code(invoke("--version", "--json")), "PAVED_RUNTIME_SYMLINK");
      configure({ runtime: tampered("executable", (tree) => chmodSync(join(tree, "VERSION"), 0o755)), integrity });
      assert.equal(code(invoke("--version", "--json")), "PAVED_RUNTIME_UNEXPECTED_EXECUTABLE");
      assert.deepEqual(readdirSync(join(consumer, ".paved", "runtime")).filter((entry) => entry.startsWith("staging-")), []);

      configure({ runtime: bundled, integrity });
      const activated = invoke("--version", "--json");
      assert.equal(activated.status, 0, activated.stdout + activated.stderr);
      const selection = JSON.parse(readFileSync(join(consumer, ".paved", "runtime", "selection.json"), "utf8")) as { integrity: string; directory: string };
      assert.equal(selection.integrity, integrity);
      assert.deepEqual(readdirSync(join(versions(), selection.directory, "node_modules")), ["paved-core"]);
      const status = JSON.parse(invoke("runtime", "status", "--json").stdout) as { data: { plugin: { bundled: boolean } } };
      assert.equal(status.data.plugin.bundled, true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

