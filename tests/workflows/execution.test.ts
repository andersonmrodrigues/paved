import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { dispatchCli } from "../../cli/runtime.ts";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("executable workflow state", () => {
  it("pauses a run for an agent question and resumes the same run after an answer", async () => {
    const project = mkdtempSync(join(tmpdir(), "paved-run-decision-"));
    try {
      const readme = "# Consumer\n";
      writeFileSync(join(project, "README.md"), readme);
      initializeConsumer(core, project, "consumer");
      const invoke = (...argv: string[]) => dispatchCli({ argv: [...argv, "--project", project, "--json"] });
      const started = await invoke("feature", "Add a behavior");
      const run = (started.data as { run: string }).run;
      const raised = await invoke("decision", "raise", "--decision", JSON.stringify({
        run, question: "Which behavior should be used?", reason: "The repository does not state the intended behavior.",
        options: [
          { id: "first", label: "First", description: "Use the first behavior.", consequence: "First is used." },
          { id: "second", label: "Second", description: "Use the second behavior.", consequence: "Second is used." },
        ],
        evidence: [{ type: "file", location: "README.md", sha256: createHash("sha256").update(readme).digest("hex") }],
        required: true, requiredAnswer: { type: "single-choice" }, effect: "record-only", candidates: ["first", "second"],
      }));
      assert.equal(raised.status, "success", JSON.stringify(raised));
      const id = (raised.data as { id: string }).id;
      const runPath = join(project, ".paved/generated/runs", `${run}.yaml`);
      const persisted = parse(readFileSync(runPath, "utf8")) as { decisions: { id: string; status: string; run?: string }[]; status: string };
      assert.equal(persisted.status, "awaiting-input");
      assert.deepEqual(persisted.decisions.map((decision) => [decision.id, decision.status, decision.run]), [[id, "ASKED", run]]);
      const blocked = await invoke("feature", "--run", run, "--advance", "--note", "Observed context");
      assert.equal(blocked.status, "awaiting_input", JSON.stringify(blocked));
      assert.equal(blocked.decisions?.[0]?.runId, run);
      const resumed = await invoke("feature", "--run", run, "--advance", "--note", "Observed context",
        "--answer", `${id}=first`, "--answered-by", "tester@example.com");
      assert.equal(resumed.status, "success", JSON.stringify(resumed));
      assert.equal((resumed.data as { run: string }).run, run);
      const shown = await invoke("decision", "show", id);
      assert.equal((shown.data as { decision: { status: string } }).decision.status, "APPLIED");
      const listed = await invoke("decision", "list");
      assert.equal((listed.data as { decisions: { id: string }[] }).decisions.some((item) => item.id === id), true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
  it("persists feature phases and blocks implementation until a matching plan is approved", async () => {
    const project = mkdtempSync(join(tmpdir(), "paved-workflow-"));
    try {
      writeFileSync(join(project, "README.md"), "# Consumer\n");
      writeFileSync(join(project, "feature.ts"), "export const enabled = false;\n");
      initializeConsumer(core, project, "consumer");
      const invoke = (...argv: string[]) => dispatchCli({ argv, cwd: project, executablePath: join(core, "cli", "index.ts") });
      const started = await invoke("feature", "Enable", "a", "new", "behavior", "--json");
      assert.equal(started.status, "success", JSON.stringify({ started, inspection: await invoke("status", "--json") }));
      const id = (started.data as { run: string }).run;
      const runPath = join(project, ".paved", "generated", "runs", `${id}.yaml`);
      const before = parse(readFileSync(runPath, "utf8")) as { phases: { phase: string; status: string }[] };
      assert.equal(before.phases[0]?.status, "running");
      assert.equal((await invoke("implement", "--run", id, "--advance", "--note", "done")).status, "failed");
      assert.equal((await invoke("feature", "--run", id, "--advance", "--note", "Scope is clear")).status, "success");
      assert.equal((await invoke("feature", "--run", id, "--advance", "--note", "Architecture inspected")).status, "success");
      const plan = join(project, ".paved", "generated", "plan.md");
      writeFileSync(plan, "Implement feature.ts with a test.\n");
      const awaiting = await invoke("feature", "--run", id, "--advance", "--note", "Plan covers the behavior", "--evidence", ".paved/generated/plan.md");
      assert.equal((awaiting.data as { status: string }).status, "awaiting-approval", JSON.stringify(awaiting));
      const withoutApproval = await invoke("feature", "--run", id, "--advance");
      assert.equal((withoutApproval.data as { status: string } | undefined)?.status, "awaiting-approval", JSON.stringify(withoutApproval));
      const relayedApproval = await invoke("feature", "--run", id, "--advance",
        "--answer", "d-0123456789abcdef0123=approve", "--answered-by", "agent@example.com");
      assert.match(JSON.stringify(relayedApproval), /approvals/);
      const run = parse(readFileSync(runPath, "utf8")) as { phases: { phase: string; status: string; gates?: { reason?: string }[] }[] };
      assert.equal(run.phases.find((phase) => phase.phase === "implementation")?.status, "pending");
      const planSha = run.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.reason?.startsWith("plan_sha256="))?.reason?.slice(12);
      assert.match(planSha ?? "", /^[a-f0-9]{64}$/);
      mkdirSync(join(project, ".paved", "approvals"));
      writeFileSync(join(project, ".paved", "approvals", `${id}.json`), JSON.stringify({
        run: id, plan_sha256: planSha, decision: "approved", decided_by: "maintainer", decided_at: new Date().toISOString(),
      }));
      const approved = await invoke("feature", "--run", id, "--advance");
      assert.equal((approved.data as { currentPhase: string }).currentPhase, "implementation", JSON.stringify(approved));
      assert.equal((await invoke("feature", "--run", id, "--advance", "--note", "done")).status, "failed");
      writeFileSync(join(project, "feature.ts"), "export const enabled = true;\n");
      const implemented = await invoke("implement", "--run", id, "--advance", "--note", "Implemented approved change");
      assert.equal(implemented.status, "success", JSON.stringify(implemented));
      assert.equal((implemented.data as { currentPhase: string }).currentPhase, "validation");
      const unavailable = await invoke("feature", "--run", id, "--advance");
      assert.equal((unavailable.data as { status: string }).status, "failed");
      assert.equal((parse(readFileSync(runPath, "utf8")) as { status: string }).status, "failed");
      const retry = await invoke("feature", "--run", id, "--advance");
      assert.equal((retry.data as { status: string }).status, "failed");
      const exhausted = await invoke("feature", "--run", id, "--advance");
      assert.equal(exhausted.diagnostics[0]?.code, "PAVED_WORKFLOW_RETRIES_EXHAUSTED");

      const rejectedStart = await invoke("feature", "A rejected feature", "--json");
      const rejectedId = (rejectedStart.data as { run: string }).run;
      const rejectedRun = join(project, ".paved", "generated", "runs", `${rejectedId}.yaml`);
      assert.equal((await invoke("feature", "--run", rejectedId, "--advance", "--note", "Expected behavior is clear")).status, "success");
      assert.equal((await invoke("feature", "--run", rejectedId, "--advance", "--note", "Architecture inspected")).status, "success");
      const rejectedPlan = join(project, ".paved", "generated", "rejected-plan.md");
      writeFileSync(rejectedPlan, "Proposed fix.\n");
      assert.equal((await invoke("feature", "--run", rejectedId, "--advance", "--note", "Feature plan", "--evidence", ".paved/generated/rejected-plan.md")).status, "warning");
      const rejectedState = parse(readFileSync(rejectedRun, "utf8")) as { phases: { phase: string; gates?: { reason?: string }[] }[] };
      const rejectedSha = rejectedState.phases.find((phase) => phase.phase === "planning")?.gates?.find((gate) => gate.reason?.startsWith("plan_sha256="))?.reason?.slice(12);
      writeFileSync(join(project, ".paved", "approvals", `${rejectedId}.json`), JSON.stringify({
        run: rejectedId, plan_sha256: rejectedSha, decision: "rejected", decided_by: "maintainer", decided_at: new Date().toISOString(),
      }));
      const rejection = await invoke("feature", "--run", rejectedId, "--advance");
      assert.equal((rejection.data as { status: string }).status, "blocked");
      assert.equal((parse(readFileSync(rejectedRun, "utf8")) as { phases: { phase: string; status: string }[] }).phases.find((phase) => phase.phase === "implementation")?.status, "pending");

      const fix = await invoke("fix", "An observed failure", "--json");
      const fixId = (fix.data as { run: string }).run;
      assert.equal((await invoke("fix", "--run", fixId, "--advance", "--note", "Expected behavior is clear")).status, "success");
      const unconfirmed = await invoke("fix", "--run", fixId, "--advance", "--note", "Hypothesized cause", "--evidence", "feature.ts");
      assert.equal(unconfirmed.diagnostics[0]?.code, "PAVED_WORKFLOW_CAUSE_UNCONFIRMED");
      const refactor = await invoke("refactor", "Simplify feature.ts", "--json");
      const refactorId = (refactor.data as { run: string }).run;
      assert.equal((await invoke("refactor", "--run", refactorId, "--advance", "--note", "Behavior must remain stable")).status, "success");
      const missingBaseline = await invoke("refactor", "--run", refactorId, "--advance", "--note", "Scope inspected", "--evidence", "feature.ts");
      assert.equal(missingBaseline.diagnostics[0]?.code, "PAVED_WORKFLOW_BASELINE_FAILED");
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});
