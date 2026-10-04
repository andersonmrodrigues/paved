import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { atomicWriteFileSync } from "../atomic-write.js";
import { loadYaml } from "../documents.js";
import { evaluateCompletion, loadEvidenceRegistry } from "../evidence.js";
import { discoverSources } from "../generator-runtime.js";
import { localApprover } from "../local-identity.js";
import { resolveSafePath } from "../safe-path.js";
import { createRegistry } from "../schemas.js";
import { sanitizeToolOutput } from "../tools.js";
import { assessWorkflowEvidence } from "../workflows.js";
import { createDiagnostic } from "../../result.js";
export const SHARED_GATES = ["plan-approved", "criteria-met"];
export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export const projectRelative = (root, path) => relative(realpathSync(root), realpathSync(path)).split(sep).join("/");
export function blocked(code, message, remediation) {
    return { kind: "blocked", code, message, remediation };
}
/** Digest of the project's source and test files, recorded when the run starts. */
export function fingerprint(projectRoot) {
    return sha(JSON.stringify(discoverSources(projectRoot)
        .filter((source) => source.kind === "source-module" || source.kind === "test")
        .map((source) => [source.path, source.sha256])));
}
export function recordObservation(context, ref) {
    const location = ref ?? (context.evidence ? projectRelative(context.projectRoot, context.evidence) : undefined);
    context.run.events.push({
        at: now(), type: "evidence-recorded", phase: context.phase.phase,
        ...(location ? { ref: location } : {}),
        detail: String(sanitizeToolOutput(context.note ?? "")).slice(0, 4000),
    });
}
export function implementationChanged(context) {
    const original = context.run.events[0]?.detail?.replace(/^source_sha256=/, "");
    return fingerprint(context.projectRoot) === original
        ? blocked("PAVED_WORKFLOW_CHANGE_MISSING", "No source or test change was observed after approval.", "Implement the approved change before advancing.")
        : undefined;
}
export function failedTestingEvidence(roots, path, run) {
    const rel = projectRelative(roots.projectRoot, path);
    if (!rel.startsWith(".paved/generated/evidence/") || !rel.endsWith(".yaml"))
        return false;
    const raw = loadYaml(path);
    const validation = createRegistry(join(roots.coreRoot, "schemas"), ["paved/v1"]).validate(raw);
    if (!validation.valid)
        return false;
    const record = raw;
    if (record.producer?.agent !== "paved-cli" || !record.change?.summary?.startsWith("Executed testing Tool ")
        || record.change.revision !== run.revision || !record.created_at || Date.parse(record.created_at) < Date.parse(run.started_at))
        return false;
    const source = raw.artifacts?.[0]?.source;
    if (source?.type !== "file" || !source.location?.startsWith(".paved/generated/evidence/") || !source.sha256)
        return false;
    const logPath = resolveSafePath(roots.projectRoot, source.location);
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
export function readApproval(projectRoot, run, planSha) {
    const path = resolveSafePath(projectRoot, `.paved/approvals/${run.id}.json`);
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
function recordApproval(projectRoot, run, planSha) {
    const path = resolveSafePath(projectRoot, `.paved/approvals/${run.id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify({ run: run.id, plan_sha256: planSha, decision: "approved",
        decided_by: localApprover(), decided_at: now() }, null, 2)}\n`);
}
const planning = (context) => {
    const { run, phase, projectRoot } = context;
    const gate = phase.gates?.find((item) => item.id === "plan-approved");
    if (!gate) {
        if (context.approve)
            return blocked("PAVED_WORKFLOW_APPROVAL_NOT_REQUESTED", "No plan awaits approval in this run.", `Request approval first with paved plan --run ${run.id} --advance --evidence <plan-path> --note <summary> --json.`);
        if (!context.evidence || !context.note)
            return blocked("PAVED_WORKFLOW_PLAN_REQUIRED", "A concrete plan file and summary are required before approval.", `Run paved plan --run ${run.id} --advance --evidence <plan-path> --note <summary> --json.`);
        const planSha = sha(readFileSync(context.evidence));
        phase.gates = [
            ...(context.gates.planningGates ?? []).map((item) => ({ ...item })),
            { id: "plan-approved", status: "awaiting-approval", requested_at: now(), reason: `plan_sha256=${planSha}` },
        ];
        run.status = "awaiting-approval";
        run.events.push({ at: now(), type: "approval-requested", phase: "planning", ref: projectRelative(projectRoot, context.evidence), detail: `plan_sha256=${planSha}` });
        return { kind: "wait", nextAction: `Show the plan to the user and ask for approval in the conversation. Only after an explicit yes, run paved plan --run ${run.id} --approve --json.` };
    }
    const planSha = gate.reason?.replace(/^plan_sha256=/, "");
    if (!planSha || !/^[a-f0-9]{64}$/.test(planSha))
        throw new Error("Workflow approval gate has no valid plan digest.");
    const planRef = run.events.findLast((event) => event.type === "approval-requested" && event.phase === "planning")?.ref;
    if (!planRef)
        throw new Error("Workflow approval request has no plan path.");
    const currentPlan = resolveSafePath(projectRoot, planRef);
    if (!existsSync(currentPlan))
        return blocked("PAVED_WORKFLOW_PLAN_MISSING", "The plan file is missing.", "Restore the plan file before requesting approval again.");
    const currentSha = sha(readFileSync(currentPlan));
    if (currentSha !== planSha) {
        gate.reason = `plan_sha256=${currentSha}`;
        gate.requested_at = now();
        run.events.push({ at: now(), type: "approval-requested", phase: "planning", ref: planRef, detail: `plan_sha256=${currentSha}` });
        run.status = "awaiting-approval";
        return { kind: "wait", nextAction: `The plan changed, so earlier approval does not cover it. Show the revised plan and ask again; after the user approves it in the conversation, run paved plan --run ${run.id} --approve --json.` };
    }
    if (context.approve && gate.status === "awaiting-approval")
        recordApproval(projectRoot, run, planSha);
    const decision = readApproval(projectRoot, run, planSha);
    if (!decision)
        return { kind: "wait", nextAction: `Awaiting the user's approval of plan_sha256 ${planSha}. After an explicit yes in the conversation, run paved plan --run ${run.id} --approve --json.` };
    gate.status = decision.decision;
    gate.decided_by = decision.decided_by;
    gate.decided_at = decision.decided_at;
    run.events.push({ at: now(), type: "approval-decided", phase: "planning", ref: "plan-approved" });
    if (decision.decision === "rejected") {
        const failure = { code: "approval-rejected", phase: "planning", reason: "Human rejected the plan.", retry: "non-retryable", next_action: "Revise the plan and start a new run with paved intent." };
        phase.status = "blocked";
        phase.failure = failure;
        run.failure = failure;
        run.status = "blocked";
        run.ended_at = now();
        run.events.push({ at: now(), type: "run-blocked", phase: "planning" });
        return { kind: "wait", nextAction: "The plan was rejected; revise it and start a new run before implementation." };
    }
    run.status = "running";
    return { kind: "pass" };
};
const validation = async (context) => {
    const tested = await context.tools.test();
    if (tested.status === "awaiting_input")
        return { kind: "relay", result: tested };
    const ref = tested.data?.evidence;
    context.run.events.push({ at: now(), type: "tool-invoked", phase: "validation", ref: ref ?? "testing-run" });
    if (tested.status !== "success") {
        return { kind: "fail", reason: "The governed regression test did not pass.", nextAction: "Fix the failure and resume this run with paved execute --advance.", diagnostics: tested.diagnostics };
    }
    return { kind: "pass" };
};
const verification = async (context) => {
    const verified = await context.tools.verify();
    if (verified.status === "awaiting_input")
        return { kind: "relay", result: verified };
    const data = verified.data;
    if (verified.status !== "success" || data?.completion?.verification !== "verified" || !data.evidence?.length) {
        for (const path of data?.evidence ?? [])
            context.run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref: path });
        return {
            kind: "fail", reason: "Authoritative Paved verification did not complete successfully.",
            nextAction: "Repair the verification profile or failed checks and resume this run.",
            diagnostics: verified.diagnostics.length ? verified.diagnostics : [createDiagnostic({
                    severity: "error", category: "config", code: "PAVED_WORKFLOW_VERIFICATION_FAILED", component: "workflow.runtime",
                    message: "Verification did not produce verified evidence.", remediation: "Inspect paved verify --json.",
                })],
        };
    }
    context.run.evidence = data.evidence[0];
    context.run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref: context.run.evidence });
    return { kind: "pass" };
};
const evidence = (context) => {
    const { run } = context;
    if (!run.evidence)
        return blocked("PAVED_WORKFLOW_EVIDENCE_MISSING", "Verified evidence is missing.", "Run the verification phase successfully first.");
    if (!context.evidence)
        return blocked("PAVED_WORKFLOW_EVIDENCE_MISSING", "Workflow evidence with a diff and check results is required.", `Provide --evidence <workflow-evidence.yaml> for run ${run.id}.`);
    const authoritative = loadYaml(resolveSafePath(context.projectRoot, run.evidence));
    const record = loadYaml(context.evidence);
    const schema = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]).validate(record);
    if (!schema.valid)
        return blocked("PAVED_WORKFLOW_EVIDENCE_INVALID", schema.errors.join("; "), "Fix the workflow evidence record and retry.");
    const problems = assessWorkflowEvidence(record, context.workflow);
    if (JSON.stringify(record.checks) !== JSON.stringify(authoritative.checks))
        problems.push("Workflow check results do not match authoritative Paved verification.");
    const evaluated = evaluateCompletion(record, loadEvidenceRegistry(join(context.coreRoot, "core/verification/registry.yaml")));
    if (evaluated.status !== "complete" || evaluated.verification !== "verified")
        problems.push(...evaluated.blocking, "Workflow evidence is not complete and verified.");
    if (problems.length)
        return blocked("PAVED_WORKFLOW_EVIDENCE_INVALID", problems.join("; "), "Record real diff and check evidence matching the Paved verification result.");
    run.evidence = projectRelative(context.projectRoot, context.evidence);
    run.events.push({ at: now(), type: "evidence-recorded", phase: "evidence", ref: run.evidence, detail: `sha256=${sha(readFileSync(context.evidence))}` });
    return { kind: "pass" };
};
const completion = (context) => {
    if (!context.run.evidence)
        return blocked("PAVED_WORKFLOW_EVIDENCE_MISSING", "The run cannot complete without verified evidence.", "Run Paved verification and record its evidence.");
    context.phase.gates = [{ id: "criteria-met", status: "passed" }];
    return { kind: "pass" };
};
const SHARED_PHASES = { planning, validation, verification, evidence, completion };
export function sharedPhase(phase) {
    return SHARED_PHASES[phase];
}
