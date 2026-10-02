import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { discoverSources } from "../lib/generator-runtime.js";
import { loadYaml } from "../lib/documents.js";
import { inspectConsumer } from "../lib/consumer-state.js";
import { localApprover } from "../lib/local-identity.js";
import { resolveSafePath } from "../lib/safe-path.js";
import { sanitizeToolOutput } from "../lib/tools.js";
import { createRegistry } from "../lib/schemas.js";
import { assessRun } from "../lib/workflows.js";
import { assessWorkflowEvidence } from "../lib/workflows.js";
import { evaluateCompletion, loadEvidenceRegistry } from "../lib/evidence.js";
import { createDiagnostic, createResult } from "../result.js";
import { testHandler } from "./test.js";
import { verifyHandler } from "./verify.js";
import { runDecisionGate, toProjection } from "../lib/decisions/gate.js";
const workflowNames = { feature: "feature", fix: "bug", refactor: "refactor" };
const firstInputs = { feature: "request", fix: "report", refactor: "request" };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const projectRelative = (root, path) => relative(realpathSync(root), realpathSync(path)).split(sep).join("/");
function diagnostic(code, message, remediation) {
    return createDiagnostic({ severity: "error", category: "config", code, component: "workflow.runtime", message, remediation });
}
function blocked(command, code, message, remediation, data) {
    return createResult({ command, status: "failed", ...(data === undefined ? {} : { data }), diagnostics: [diagnostic(code, message, remediation)] });
}
function fingerprint(projectRoot) {
    return sha(JSON.stringify(discoverSources(projectRoot)
        .filter((source) => source.kind === "source-module" || source.kind === "test")
        .map((source) => [source.path, source.sha256])));
}
function revision(projectRoot) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", shell: false });
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : "unversioned";
}
function contract(invocation, command) {
    return loadYaml(join(invocation.paths.coreRoot, "core", "workflows", workflowNames[command], "workflow.yaml"));
}
function runPath(projectRoot, id) {
    if (!/^[a-z][a-z0-9-]{5,80}$/.test(id))
        throw new Error("Invalid workflow run id.");
    return resolveSafePath(projectRoot, `.paved/generated/runs/${id}.yaml`);
}
function validated(run, workflow, invocation) {
    const registry = createRegistry(join(invocation.paths.coreRoot, "schemas"), ["paved/v1"]);
    const result = registry.validate(run);
    if (!result.valid)
        throw new Error(`WorkflowRun is invalid: ${result.errors.join("; ")}`);
    const problems = assessRun(run, workflow);
    if (problems.length)
        throw new Error(`WorkflowRun is inconsistent: ${problems.join("; ")}`);
}
function save(run, workflow, invocation) {
    validated(run, workflow, invocation);
    const path = runPath(invocation.paths.projectRoot, run.id);
    mkdirSync(join(path, ".."), { recursive: true });
    atomicWriteFileSync(path, stringify(run));
}
function load(invocation, workflow, id) {
    const path = runPath(invocation.paths.projectRoot, id);
    if (!existsSync(path))
        throw new Error(`Workflow run ${id} does not exist.`);
    const run = loadYaml(path);
    validated(run, workflow, invocation);
    const gate = run.phases.find((phase) => phase.phase === "planning")?.gates?.find((item) => item.id === "plan-approved");
    if (gate?.status === "approved" || gate?.status === "rejected") {
        const digest = gate.reason?.replace(/^plan_sha256=/, "");
        const planRef = run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
        if (!digest || !planRef || !/^[a-f0-9]{64}$/.test(digest))
            throw new Error("Workflow approval provenance is missing.");
        const planPath = resolveSafePath(invocation.paths.projectRoot, planRef);
        if (!existsSync(planPath) || sha(readFileSync(planPath)) !== digest)
            throw new Error("Approved plan content has changed.");
        const decision = approval(invocation, run, digest);
        if (decision?.decision !== gate.status || decision?.decided_by !== gate.decided_by || decision?.decided_at !== gate.decided_at) {
            throw new Error("Workflow approval state does not match the human-owned approval record.");
        }
    }
    const recorded = run.events.find((event) => event.type === "evidence-recorded" && event.phase === "evidence" && event.detail?.startsWith("sha256="));
    if (recorded) {
        if (!run.evidence)
            throw new Error("Workflow evidence path is missing.");
        const path = resolveSafePath(invocation.paths.projectRoot, run.evidence);
        if (!existsSync(path) || sha(readFileSync(path)) !== recorded.detail?.slice(7))
            throw new Error("Workflow evidence changed after recording.");
    }
    return run;
}
function result(command, run, nextAction, diagnostics = []) {
    const failed = run.status === "failed" || run.status === "blocked" || diagnostics.some((item) => item.category !== "findings");
    const retained = failed && diagnostics.length === 0
        ? [diagnostic(run.status === "blocked" ? "PAVED_WORKFLOW_BLOCKED" : "PAVED_WORKFLOW_FAILED", run.failure?.reason ?? "Workflow cannot continue.", nextAction)]
        : diagnostics;
    const open = (run.decisions ?? []).filter((item) => item.status === "ASKED");
    return createResult({ command, status: failed ? "failed" : run.status === "awaiting-input" ? "awaiting_input" : run.status === "awaiting-approval" ? "warning" : "success", ...(open.length ? { decisions: open.map(toProjection) } : {}), data: {
            run: run.id, workflow: run.workflow, status: run.status,
            currentPhase: run.phases.find((phase) => phase.status === "running")?.phase,
            evidence: run.evidence,
            evidenceProduced: run.events.flatMap((event) => event.ref?.startsWith(".paved/generated/evidence/") ? [event.ref] : []),
            nextAction,
        }, diagnostics: retained });
}
function runDecisionCandidate(decision) {
    const candidates = decision.fingerprint.inputs.filter((item) => item.startsWith("candidate:"))
        .map((item) => item.slice("candidate:".length));
    return {
        scope: "run", question: decision.question, reason: decision.reason,
        options: decision.options,
        ...(decision.recommended_option === undefined ? {} : { recommended: decision.recommended_option }),
        evidence: decision.evidence, required: decision.required, requiredAnswer: decision.required_answer,
        effect: decision.effect ?? "record-only", handler: "run.record", candidates,
        ...(decision.depends_on === undefined ? {} : { dependsOn: decision.depends_on }),
    };
}
function resolveRunDecisions(invocation, command, run) {
    const before = new Map((run.decisions ?? []).map((decision) => [decision.id, decision.status]));
    const hasPlanApproval = run.phases.some((phase) => phase.gates?.some((gate) => gate.id === "plan-approved" && gate.status === "awaiting-approval"));
    const answers = invocation.flags.answers.filter((item) => {
        const id = item.slice(0, item.indexOf("="));
        return before.has(id) || !hasPlanApproval;
    });
    const storage = {
        list: () => [...(run.decisions ?? [])],
        read: (id) => run.decisions?.find((decision) => decision.id === id),
        write: (decision) => {
            const next = [...(run.decisions ?? [])];
            const index = next.findIndex((item) => item.id === decision.id);
            if (index < 0)
                next.push(decision);
            else
                next[index] = decision;
            run.decisions = next;
        },
    };
    const outcome = runDecisionGate({
        context: {
            projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
            command, run: run.id, answers,
            ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
        },
        providers: [() => (run.decisions ?? []).map(runDecisionCandidate)],
        handlers: new Map([["run.record", { effect: "record-only", apply: () => [] }]]),
        persist: true, storage,
    });
    for (const decision of run.decisions ?? []) {
        const previous = before.get(decision.id);
        if (previous === undefined)
            run.events.push({ at: now(), type: "decision-raised", ref: decision.id });
        if (previous !== "ASKED" && decision.status === "ASKED")
            run.events.push({ at: now(), type: "decision-asked", ref: decision.id });
        if (previous !== "ANSWERED" && decision.status === "ANSWERED")
            run.events.push({ at: now(), type: "decision-answered", ref: decision.id });
        if (previous !== "APPLIED" && decision.status === "APPLIED")
            run.events.push({ at: now(), type: "decision-applied", ref: decision.id });
        if (previous !== undefined && previous !== "SUPERSEDED" && decision.status === "SUPERSEDED")
            run.events.push({ at: now(), type: "decision-superseded", ref: decision.id });
    }
    return outcome;
}
function start(invocation, command, workflow) {
    const request = invocation.selectors.join(" ").trim();
    if (!request)
        return blocked(command, "PAVED_WORKFLOW_INPUT_REQUIRED", `${command} requires a concrete request.`, `Run paved ${command} <request> --json.`);
    const inspection = inspectConsumer({ projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot });
    if (!["RESOLVED", "GENERATED", "VALIDATED", "READY"].includes(inspection.lifecycleState)) {
        return blocked(command, "PAVED_WORKFLOW_LIFECYCLE_BLOCKED", `Cannot start ${command} in lifecycle state ${inspection.lifecycleState}.`, "Run paved doctor and resolve the reported state first.");
    }
    const sourceRevision = revision(invocation.paths.projectRoot);
    const id = `${command}-${sha(`${request}\0${sourceRevision}`).slice(0, 20)}`;
    const path = runPath(invocation.paths.projectRoot, id);
    if (existsSync(path))
        return result(command, load(invocation, workflow, id), `Resume with paved ${command} --run ${id} --advance --note <observation> --json.`);
    const created = now();
    const run = {
        apiVersion: "paved/v1", kind: "WorkflowRun", id,
        workflow: { id: workflow.id, version: workflow.version }, revision: sourceRevision, started_at: created,
        status: "running", inputs: [{ id: firstInputs[command], value: request, source: "human" }],
        phases: workflow.phases.map((phase, index) => ({ phase: phase.phase, status: index === 0 ? "running" : "pending", ...(index === 0 ? { attempts: 1 } : {}) })),
        events: [{ at: created, type: "run-started", detail: `source_sha256=${fingerprint(invocation.paths.projectRoot)}` }, { at: created, type: "phase-started", phase: workflow.phases[0].phase }],
    };
    save(run, workflow, invocation);
    return result(command, run, `Complete ${run.phases[0].phase}, then run paved ${command} --run ${id} --advance --note <observation> --json.`);
}
function evidencePath(invocation) {
    if (!invocation.flags.evidence)
        return undefined;
    const path = resolveSafePath(invocation.paths.projectRoot, invocation.flags.evidence);
    if (!existsSync(path))
        throw new Error(`Evidence file does not exist: ${invocation.flags.evidence}`);
    return path;
}
function failedTestingEvidence(invocation, path, run) {
    const rel = projectRelative(invocation.paths.projectRoot, path);
    if (!rel.startsWith(".paved/generated/evidence/") || !rel.endsWith(".yaml"))
        return false;
    const raw = loadYaml(path);
    const validation = createRegistry(join(invocation.paths.coreRoot, "schemas"), ["paved/v1"]).validate(raw);
    if (!validation.valid)
        return false;
    const record = raw;
    if (record.producer?.agent !== "paved-cli" || !record.change?.summary?.startsWith("Executed testing Tool ")
        || record.change.revision !== run.revision || !record.created_at || Date.parse(record.created_at) < Date.parse(run.started_at))
        return false;
    const source = raw.artifacts?.[0]?.source;
    if (source?.type !== "file" || !source.location?.startsWith(".paved/generated/evidence/") || !source.sha256)
        return false;
    const logPath = resolveSafePath(invocation.paths.projectRoot, source.location);
    if (!existsSync(logPath))
        return false;
    const log = readFileSync(logPath, "utf8");
    if (sha(log) !== source.sha256)
        return false;
    const line = log.split("\n").find((entry) => entry.startsWith("tool_result_json: "));
    if (!line)
        return false;
    try {
        const execution = JSON.parse(line.slice("tool_result_json: ".length));
        return execution.status === "failed" && execution.error_code === "execution-failure" && typeof execution.exit_code === "number" && execution.exit_code > 0;
    }
    catch {
        return false;
    }
}
function approval(invocation, run, planSha) {
    const path = resolveSafePath(invocation.paths.projectRoot, `.paved/approvals/${run.id}.json`);
    if (!existsSync(path))
        return undefined;
    const document = JSON.parse(readFileSync(path, "utf8"));
    if (document.plan_sha256 !== planSha)
        return undefined;
    if (document.run !== run.id || !["approved", "rejected"].includes(String(document.decision))
        || typeof document.decided_by !== "string" || !document.decided_by.trim() || ["agent", "paved", "ci"].includes(document.decided_by)
        || typeof document.decided_at !== "string" || Number.isNaN(Date.parse(document.decided_at))) {
        throw new Error("Approval record is invalid or does not match the current plan. A human must decide the exact plan in .paved/approvals/<run-id>.json.");
    }
    return { decision: document.decision, decided_by: document.decided_by, decided_at: document.decided_at };
}
// The user approves in the conversation; this records that decision for the exact plan version shown.
function recordApproval(invocation, run, planSha) {
    const path = resolveSafePath(invocation.paths.projectRoot, `.paved/approvals/${run.id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify({ run: run.id, plan_sha256: planSha, decision: "approved",
        decided_by: localApprover(), decided_at: now() }, null, 2)}\n`);
}
function completeAndStartNext(run, phase) {
    phase.status = "completed";
    run.events.push({ at: now(), type: "phase-completed", phase: phase.phase });
    const index = run.phases.indexOf(phase);
    const next = run.phases[index + 1];
    if (next) {
        next.status = "running";
        next.attempts = (next.attempts ?? 0) + 1;
        run.events.push({ at: now(), type: "phase-started", phase: next.phase });
    }
    else {
        run.status = "completed";
        run.ended_at = now();
        run.events.push({ at: now(), type: "run-completed" });
    }
}
function failRun(run, phase, code, reason, nextAction) {
    const failure = { code, phase: phase.phase, reason, retry: "retryable", next_action: nextAction };
    phase.status = "failed";
    phase.failure = failure;
    run.failure = failure;
    run.status = "failed";
    run.ended_at = now();
    run.events.push({ at: now(), type: "phase-failed", phase: phase.phase, detail: reason }, { at: now(), type: "run-failed", phase: phase.phase });
}
async function advance(invocation, command, workflow, run) {
    if (run.status === "completed" || run.status === "blocked")
        return result(command, run, "This run is terminal. Start a new request for further work.");
    const decisions = resolveRunDecisions(invocation, command, run);
    if (decisions.problems.length > 0) {
        return blocked(command, "PAVED_DECISION_ANSWER_INVALID", decisions.problems.join("; "), "Answer an open run decision with one of its offered options.", { run: run.id });
    }
    if (decisions.status === "awaiting-input") {
        run.status = "awaiting-input";
        save(run, workflow, invocation);
        return result(command, run, `Answer the run decision, then resume with paved ${command} --run ${run.id} --advance --answer <id>=<value> --answered-by <you>.`);
    }
    if (run.status === "awaiting-input")
        run.status = "running";
    if (decisions.applied.length > 0)
        save(run, workflow, invocation);
    let phase = run.phases.find((item) => item.status === "running");
    if (!phase && run.status === "failed") {
        phase = run.phases.find((item) => item.status === "failed");
        if (!phase)
            throw new Error("Failed run has no failed phase.");
        const contractPhase = workflow.phases.find((item) => item.phase === phase.phase);
        const retryLimit = contractPhase?.retry?.class === "non-retryable" ? 1 : (contractPhase?.retry?.max_attempts ?? 2);
        if ((phase.attempts ?? 0) >= retryLimit)
            return blocked(command, "PAVED_WORKFLOW_RETRIES_EXHAUSTED", `${phase.phase} exhausted its ${retryLimit} attempts.`, "A human must inspect the failure and start a new run or change the approved plan.");
        phase.status = "running";
        delete phase.failure;
        delete run.failure;
        delete run.ended_at;
        run.status = "running";
        phase.attempts = (phase.attempts ?? 0) + 1;
        run.events.push({ at: now(), type: "retry-started", phase: phase.phase });
    }
    if (!phase)
        throw new Error("Run has no active phase.");
    if (invocation.flags.approve && phase.phase !== "planning")
        return blocked(command, "PAVED_WORKFLOW_APPROVAL_NOT_REQUESTED", "No plan awaits approval in this run.", `Resume with paved ${command} --run ${run.id} --advance --json.`, { run: run.id });
    const note = invocation.flags.note?.trim();
    const evidence = evidencePath(invocation);
    if (phase.phase === "planning") {
        const gate = phase.gates?.find((item) => item.id === "plan-approved");
        if (!gate && invocation.flags.approve)
            return blocked(command, "PAVED_WORKFLOW_APPROVAL_NOT_REQUESTED", "No plan awaits approval in this run.", `Request approval first with paved ${command} --run ${run.id} --advance --evidence <plan-path> --note <summary> --json.`, { run: run.id });
        if (!gate) {
            if (!evidence || !note)
                return blocked(command, "PAVED_WORKFLOW_PLAN_REQUIRED", "A concrete plan file and summary are required before approval.", `Run paved ${command} --run ${run.id} --advance --evidence <plan-path> --note <summary> --json.`, { run: run.id });
            const planSha = sha(readFileSync(evidence));
            phase.gates = [
                ...(command === "feature" ? [{ id: "claims-planned", status: "passed" }, { id: "boundary-exception", status: "not-applicable", reason: "No exception was requested in the approved plan." }] : []),
                { id: "plan-approved", status: "awaiting-approval", requested_at: now(), reason: `plan_sha256=${planSha}` },
            ];
            run.status = "awaiting-approval";
            run.events.push({ at: now(), type: "approval-requested", phase: "planning", ref: projectRelative(invocation.paths.projectRoot, evidence), detail: `plan_sha256=${planSha}` });
            save(run, workflow, invocation);
            return result(command, run, `Show the plan to the user and ask for approval in the conversation. Only after an explicit yes, run paved ${command} --run ${run.id} --approve --json.`);
        }
        const planSha = gate.reason?.replace(/^plan_sha256=/, "");
        if (!planSha || !/^[a-f0-9]{64}$/.test(planSha))
            throw new Error("Workflow approval gate has no valid plan digest.");
        const planRef = run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
        if (!planRef)
            throw new Error("Workflow approval request has no plan path.");
        const currentPlan = resolveSafePath(invocation.paths.projectRoot, planRef);
        if (!existsSync(currentPlan))
            return blocked(command, "PAVED_WORKFLOW_PLAN_MISSING", "The plan file is missing.", "Restore the plan file before requesting approval again.");
        const currentSha = sha(readFileSync(currentPlan));
        if (currentSha !== planSha) {
            gate.reason = `plan_sha256=${currentSha}`;
            gate.requested_at = now();
            run.events.push({ at: now(), type: "approval-requested", phase: "planning", ref: planRef, detail: `plan_sha256=${currentSha}` });
            run.status = "awaiting-approval";
            save(run, workflow, invocation);
            return result(command, run, `The plan changed, so earlier approval does not cover it. Show the revised plan and ask again; after the user approves it in the conversation, run paved ${command} --run ${run.id} --approve --json.`);
        }
        if (invocation.flags.approve && gate.status === "awaiting-approval")
            recordApproval(invocation, run, planSha);
        const decision = approval(invocation, run, planSha);
        if (!decision)
            return result(command, run, `Awaiting the user's approval of plan_sha256 ${planSha}. After an explicit yes in the conversation, run paved ${command} --run ${run.id} --approve --json.`);
        gate.status = decision.decision;
        gate.decided_by = decision.decided_by;
        gate.decided_at = decision.decided_at;
        run.events.push({ at: now(), type: "approval-decided", phase: "planning", ref: "plan-approved" });
        if (decision.decision === "rejected") {
            const failure = { code: "approval-rejected", phase: "planning", reason: "Human rejected the plan.", retry: "non-retryable", next_action: "Revise the plan and start a new workflow run." };
            phase.status = "blocked";
            phase.failure = failure;
            run.failure = failure;
            run.status = "blocked";
            run.ended_at = now();
            run.events.push({ at: now(), type: "run-blocked", phase: "planning" });
        }
        else {
            run.status = "running";
            completeAndStartNext(run, phase);
        }
        save(run, workflow, invocation);
        return result(command, run, decision.decision === "approved" ? "The approved plan may now be implemented." : "The plan was rejected; revise it before implementation.");
    }
    if (phase.phase === "validation") {
        const tested = await testHandler(invocation);
        const testedEvidence = tested.data?.evidence;
        run.events.push({ at: now(), type: "tool-invoked", phase: "validation", ref: testedEvidence ?? "testing-run" });
        if (tested.status !== "success") {
            failRun(run, phase, "verification-failed", "The governed regression test did not pass.", "Fix the failure and resume this run.");
            save(run, workflow, invocation);
            return result(command, run, "Fix the test failure, then resume with --advance.", tested.diagnostics);
        }
    }
    else if (phase.phase === "verification") {
        const verified = await verifyHandler(invocation);
        const data = verified.data;
        if (verified.status !== "success" || data?.completion?.verification !== "verified" || !data.evidence?.length) {
            for (const path of data?.evidence ?? [])
                run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref: path });
            failRun(run, phase, "verification-failed", "Authoritative Paved verification did not complete successfully.", "Repair the verification profile or failed checks and resume this run.");
            save(run, workflow, invocation);
            return result(command, run, "Repair verification before completion.", verified.diagnostics.length ? verified.diagnostics : [diagnostic("PAVED_WORKFLOW_VERIFICATION_FAILED", "Verification did not produce verified evidence.", "Inspect paved verify --json.")]);
        }
        run.evidence = data.evidence[0];
        run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref: run.evidence });
    }
    else if (phase.phase === "evidence") {
        if (!run.evidence)
            return blocked(command, "PAVED_WORKFLOW_EVIDENCE_MISSING", "Verified evidence is missing.", "Run the verification phase successfully first.");
        if (!evidence)
            return blocked(command, "PAVED_WORKFLOW_EVIDENCE_MISSING", "Workflow evidence with a diff and check results is required.", `Provide --evidence <workflow-evidence.yaml> for run ${run.id}.`);
        const authoritative = loadYaml(resolveSafePath(invocation.paths.projectRoot, run.evidence));
        const record = loadYaml(evidence);
        const schema = createRegistry(join(invocation.paths.coreRoot, "schemas"), ["paved/v1"]).validate(record);
        if (!schema.valid)
            return blocked(command, "PAVED_WORKFLOW_EVIDENCE_INVALID", schema.errors.join("; "), "Fix the workflow evidence record and retry.");
        const problems = assessWorkflowEvidence(record, workflow);
        if (JSON.stringify(record.checks) !== JSON.stringify(authoritative.checks))
            problems.push("Workflow check results do not match authoritative Paved verification.");
        const evaluated = evaluateCompletion(record, loadEvidenceRegistry(join(invocation.paths.coreRoot, "core/verification/registry.yaml")));
        if (evaluated.status !== "complete" || evaluated.verification !== "verified")
            problems.push(...evaluated.blocking, "Workflow evidence is not complete and verified.");
        if (problems.length)
            return blocked(command, "PAVED_WORKFLOW_EVIDENCE_INVALID", problems.join("; "), "Record real diff and check evidence matching the Paved verification result.");
        run.evidence = projectRelative(invocation.paths.projectRoot, evidence);
        run.events.push({ at: now(), type: "evidence-recorded", phase: "evidence", ref: run.evidence, detail: `sha256=${sha(readFileSync(evidence))}` });
    }
    else if (phase.phase === "completion") {
        if (!run.evidence)
            return blocked(command, "PAVED_WORKFLOW_EVIDENCE_MISSING", "The run cannot complete without verified evidence.", "Run Paved verification and record its evidence.");
        phase.gates = [{ id: "criteria-met", status: "passed" }];
    }
    else {
        if (!note)
            return blocked(command, "PAVED_WORKFLOW_OBSERVATION_REQUIRED", `${phase.phase} requires a concrete observation.`, `Run paved ${command} --run ${run.id} --advance --note <observation> --json.`);
        if (phase.phase === "discovery" && command === "fix" && (!evidence || !failedTestingEvidence(invocation, evidence, run)))
            return blocked(command, "PAVED_WORKFLOW_CAUSE_UNCONFIRMED", "A confirmed cause needs a current failed regression result from the governed testing Tool.", "Run paved test on the unfixed code, then pass its evidence YAML with --evidence and document the observed cause.");
        if (phase.phase === "discovery" && command === "refactor" && !evidence)
            return blocked(command, "PAVED_WORKFLOW_BASELINE_MISSING", "A refactor needs existing behavior pinned by test evidence.", "Supply --evidence <repository-relative-path> for the baseline.");
        if (phase.phase === "discovery" && command === "refactor") {
            const baseline = await testHandler(invocation);
            if (baseline.status !== "success")
                return blocked(command, "PAVED_WORKFLOW_BASELINE_FAILED", "The governed baseline test did not pass before refactoring.", "Configure a valid testing Tool and establish a passing baseline before changing code.");
            run.events.push({ at: now(), type: "tool-invoked", phase: "discovery", ref: "testing-run" });
        }
        if (phase.phase === "implementation") {
            const original = run.events[0]?.detail?.replace(/^source_sha256=/, "");
            if (fingerprint(invocation.paths.projectRoot) === original)
                return blocked(command, "PAVED_WORKFLOW_CHANGE_MISSING", "No source or test change was observed after approval.", "Implement the approved change before advancing.");
        }
        if (phase.phase === "context" && command === "feature")
            phase.gates = [{ id: "scope-clear", status: "passed" }];
        if (phase.phase === "context" && command === "fix")
            phase.gates = [{ id: "expected-behavior-known", status: "passed" }];
        if (phase.phase === "discovery" && command === "fix")
            phase.gates = [{ id: "cause-confirmed", status: "passed" }];
        if (phase.phase === "discovery" && command === "refactor")
            phase.gates = [{ id: "behavior-pinned", status: "passed" }, { id: "uncovered-risk", status: "not-applicable", reason: "Baseline test evidence was supplied." }];
        if (phase.phase === "implementation" && command === "fix") {
            if (!run.events.some((event) => event.phase === "discovery" && event.type === "evidence-recorded" && event.ref?.startsWith(".paved/generated/evidence/"))) {
                return blocked(command, "PAVED_WORKFLOW_REGRESSION_MISSING", "No failed pre-fix regression result was recorded.", "Reproduce the failure through the governed testing Tool before implementing the fix.");
            }
            phase.gates = [{ id: "test-failed-first", status: "passed" }];
        }
        run.events.push({ at: now(), type: "evidence-recorded", phase: phase.phase, ...(evidence ? { ref: projectRelative(invocation.paths.projectRoot, evidence) } : {}), detail: String(sanitizeToolOutput(note)).slice(0, 4000) });
    }
    completeAndStartNext(run, phase);
    save(run, workflow, invocation);
    return result(command, run, run.status === "completed" ? "Workflow complete with authoritative verification evidence." : `Continue ${run.phases.find((item) => item.status === "running")?.phase} and resume with --run ${run.id} --advance.`);
}
export async function workflowHandler(invocation) {
    const command = invocation.command;
    const workflow = contract(invocation, command);
    try {
        if (!invocation.flags.run)
            return start(invocation, command, workflow);
        const run = load(invocation, workflow, invocation.flags.run);
        if (!invocation.flags.advance && !invocation.flags.approve)
            return result(command, run, `Resume with paved ${command} --run ${run.id} --advance --json.`);
        return await advance(invocation, command, workflow, run);
    }
    catch (error) {
        return blocked(command, "PAVED_WORKFLOW_STATE_INVALID", error instanceof Error ? error.message : "Workflow failed.", "Inspect the workflow run and correct its state before retrying.");
    }
}
