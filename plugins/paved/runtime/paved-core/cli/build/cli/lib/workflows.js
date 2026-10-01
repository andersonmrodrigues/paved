// Checks on workflows and their runs that JSON Schema cannot express: phase order,
// safe use of tools, skill orchestration without duplication, verifiable outcomes, and
// whether a run record is consistent with its workflow. Run after schema validation and
// reference resolution. See docs/concepts/workflows.md.
import { dependencyCycles, duplicatedSentences, genericityProblems, planCoverageProblems, saysWhenToUse, } from "./skills.js";
export const WORKFLOW_MAX_LINES = 80;
export const SKILLS_PER_PHASE = 3;
export const DEFAULT_RETRY = { class: "retryable", max_attempts: 2 };
/** The run status and retry class each failure code implies. One table; docs and records follow it. */
export const FAILURE_CODES = {
    "input-missing": { status: "blocked", retry: "requires-human" },
    "precondition-failed": { status: "blocked", retry: "requires-human" },
    "context-missing": { status: "blocked", retry: "requires-human" },
    "tool-unavailable": { status: "blocked", retry: "requires-human" },
    "skill-unavailable": { status: "blocked", retry: "non-retryable" },
    "rule-violation": { status: "blocked", retry: "requires-human" },
    "approval-required": { status: "awaiting-approval", retry: "requires-human" },
    "approval-rejected": { status: "blocked", retry: "non-retryable" },
    "skill-failed": { status: "failed", retry: "retryable" },
    "verification-failed": { status: "failed", retry: "retryable" },
    inconclusive: { status: "failed", retry: "retryable" },
    "evidence-insufficient": { status: "failed", retry: "retryable" },
    "retries-exhausted": { status: "failed", retry: "requires-human" },
};
// Change types whose runs act on shared or production systems, and the approval a gate
// must carry somewhere in the workflow.
const HIGH_RISK = { release: "release", incident: "production-change" };
const listed = (phase) => [...(phase.tools?.required ?? []), ...(phase.tools?.optional ?? [])];
/** Required dependencies of `id`, transitively. */
function requiredClosure(id, skills, seen = new Set()) {
    for (const dep of skills.get(id)?.depends_on?.required ?? []) {
        if (!seen.has(dep)) {
            seen.add(dep);
            requiredClosure(dep, skills, seen);
        }
    }
    return seen;
}
/** Problems with one workflow's structure, safety, verifiability and use of skills. */
export function assessWorkflowQuality(files, context) {
    const { contract, body } = files;
    const problems = [];
    const phases = contract.phases;
    const indexes = phases.map((p) => context.phaseOrder.indexOf(p.phase));
    for (let i = 1; i < indexes.length; i++) {
        if (indexes[i] <= indexes[i - 1])
            problems.push(`phase "${phases[i].phase}" is out of canonical order or repeated`);
    }
    const gateIds = phases.flatMap((p) => (p.gates ?? []).map((g) => g.id));
    if (new Set(gateIds).size !== gateIds.length)
        problems.push("gate ids are not unique");
    if (!saysWhenToUse(contract.description))
        problems.push('description does not say when to use the workflow ("Use when …")');
    problems.push(...genericityProblems("workflow", `${contract.description}\n${body}`));
    const lines = body.split("\n").length;
    if (lines > WORKFLOW_MAX_LINES) {
        problems.push(`WORKFLOW.md has ${lines} lines (limit ${WORKFLOW_MAX_LINES}); move procedure into skills`);
    }
    for (const phase of phases) {
        if ((phase.skills ?? []).length > SKILLS_PER_PHASE) {
            problems.push(`phase ${phase.phase} activates more than ${SKILLS_PER_PHASE} skills; split the work or compose skills`);
        }
    }
    // Everything the contract names directly is explained in WORKFLOW.md.
    for (const id of [...(contract.rules ?? []), ...phases.flatMap(listed), ...(contract.references ?? [])]) {
        if (!body.includes(id))
            problems.push(`WORKFLOW.md never mentions ${id}, which workflow.yaml lists`);
    }
    // A software change must be proven: required checks that can prove something, and evidence.
    const changesCode = phases.some((p) => p.phase === "implementation");
    const required = phases.flatMap((p) => p.verification?.required ?? []);
    if (changesCode) {
        const verification = phases.find((p) => p.phase === "verification");
        if ((verification?.verification?.required ?? []).length === 0) {
            problems.push("the workflow changes code but its verification phase requires no check type");
        }
        if (contract.evidence.required.length === 0)
            problems.push("the workflow changes code but requires no evidence");
    }
    for (const type of required) {
        if ((context.supports.get(type) ?? []).length === 0) {
            problems.push(`required check type ${type} cannot prove anything; make it recommended`);
        }
    }
    // Tool safety holds through the workflow: destructive tools, used directly or by a
    // phase's skills, need a destructive-operation approval gate in that phase and no
    // automatic retry.
    for (const phase of phases) {
        const tools = [...listed(phase), ...(phase.skills ?? []).flatMap((id) => {
                const skill = context.skills.get(id);
                return [...(skill?.tools?.required ?? []), ...(skill?.tools?.optional ?? [])];
            })];
        const destructive = tools.filter((id) => context.toolSafety.get(id) === "destructive");
        if (destructive.length > 0) {
            if (!(phase.gates ?? []).some((g) => g.approval === "destructive-operation")) {
                problems.push(`phase ${phase.phase} can use destructive tools (${destructive.join(", ")}) without an approval gate ("destructive-operation")`);
            }
            if ((phase.retry ?? DEFAULT_RETRY).class === "retryable") {
                problems.push(`phase ${phase.phase} can use destructive tools but is retried automatically`);
            }
        }
    }
    const approval = HIGH_RISK[contract.change_type];
    if (approval !== undefined && !phases.some((p) => (p.gates ?? []).some((g) => g.approval === approval))) {
        problems.push(`a ${contract.change_type} workflow needs a gate with approval "${approval}"`);
    }
    // Skills are orchestrated, not duplicated: a skill already brought in as a required
    // dependency of a skill listed in the same or an earlier phase must not be listed again.
    const dependencies = new Set();
    for (const phase of phases) {
        const listedSkills = phase.skills ?? [];
        const brought = new Set(listedSkills.flatMap((id) => [...requiredClosure(id, context.skills)]));
        for (const id of listedSkills) {
            if (brought.has(id) || dependencies.has(id)) {
                problems.push(`phase ${phase.phase} lists ${id}, which another listed skill already activates as a required dependency`);
            }
        }
        for (const id of brought)
            dependencies.add(id);
    }
    const reachable = new Set(phases.flatMap((p) => p.skills ?? []));
    for (const id of [...reachable])
        for (const dep of requiredClosure(id, context.skills))
            reachable.add(dep);
    for (const id of reachable) {
        if (context.skills.get(id)?.status === "deprecated")
            problems.push(`uses deprecated skill ${id}`);
    }
    const contracts = [...reachable].flatMap((id) => {
        const skill = context.skills.get(id);
        return skill === undefined ? [] : [skill];
    });
    problems.push(...dependencyCycles(contracts).map((cycle) => `skill dependency cycle: ${cycle}`));
    const skillTexts = contracts.flatMap((s) => (s.body === undefined ? [] : [{ id: s.id, text: s.body }]));
    problems.push(...duplicatedSentences([{ id: contract.id, text: body }, ...skillTexts]).filter((p) => p.includes(contract.id)));
    return problems;
}
const DONE = new Set(["completed", "skipped"]);
/** Problems with a run record measured against the workflow it claims to run. */
export function assessRun(run, workflow) {
    const problems = [];
    if (run.workflow.id !== workflow.id || run.workflow.version !== workflow.version) {
        problems.push(`run is for ${run.workflow.id}@${run.workflow.version}, not ${workflow.id}@${workflow.version}`);
        return problems;
    }
    const expected = workflow.phases.map((p) => p.phase);
    const actual = run.phases.map((p) => p.phase);
    if (expected.join(",") !== actual.join(",")) {
        problems.push(`run phases [${actual.join(", ")}] differ from the workflow's [${expected.join(", ")}]`);
        return problems;
    }
    const received = new Set(run.inputs.map((i) => i.id));
    const known = new Set(workflow.inputs.map((i) => i.id));
    for (const input of workflow.inputs) {
        if (input.required && !received.has(input.id) && run.phases.some((p) => p.status !== "pending")) {
            problems.push(`required input ${input.id} is missing, but phases have started`);
        }
    }
    for (const id of received)
        if (!known.has(id))
            problems.push(`input ${id} is not declared by the workflow`);
    let running = 0;
    run.phases.forEach((record, i) => {
        const phase = workflow.phases[i];
        if (record.status === "running")
            running++;
        // No phase starts before every earlier phase is done: nothing is skipped silently.
        if (record.status !== "pending" && !run.phases.slice(0, i).every((p) => DONE.has(p.status))) {
            problems.push(`phase ${record.phase} is ${record.status} although an earlier phase is not completed or skipped`);
        }
        if (record.status === "skipped" && phase.skip_when === undefined) {
            problems.push(`phase ${record.phase} was skipped but the workflow does not allow skipping it`);
        }
        const retry = phase.retry ?? DEFAULT_RETRY;
        const limit = retry.class === "retryable" ? (retry.max_attempts ?? DEFAULT_RETRY.max_attempts) : 1;
        if ((record.attempts ?? 0) > limit && record.failure?.code !== "retries-exhausted") {
            problems.push(`phase ${record.phase} has ${record.attempts} attempts; its limit is ${limit}`);
        }
        const gates = new Map((record.gates ?? []).map((g) => [g.id, g.status]));
        for (const id of gates.keys()) {
            if (!(phase.gates ?? []).some((g) => g.id === id))
                problems.push(`phase ${record.phase} records unknown gate ${id}`);
        }
        for (const gate of phase.gates ?? []) {
            const status = gates.get(gate.id);
            if (status === "passed" && gate.approval !== undefined) {
                problems.push(`gate ${gate.id} needs a human approval; "passed" does not satisfy it`);
            }
            if (status === "not-applicable" && gate.when === undefined) {
                problems.push(`gate ${gate.id} is unconditional and cannot be not-applicable`);
            }
            if (record.status === "completed") {
                const satisfied = status === "not-applicable" || status === (gate.approval === undefined ? "passed" : "approved");
                if (!satisfied)
                    problems.push(`phase ${record.phase} is completed but gate ${gate.id} is ${status ?? "not recorded"}`);
            }
        }
        if (record.failure !== undefined)
            problems.push(...failureProblems(record.failure, record.phase));
    });
    if (running > 1)
        problems.push("more than one phase is running");
    const allDone = run.phases.every((p) => DONE.has(p.status));
    if ((run.status === "completed" || run.status === "completed-with-warnings") && !allDone) {
        problems.push(`run is ${run.status} but not every phase is completed or skipped`);
    }
    if (run.status === "running" && allDone)
        problems.push("run is running but every phase is done");
    if (run.status === "awaiting-approval" && !run.phases.some((p) => (p.gates ?? []).some((g) => g.status === "awaiting-approval"))) {
        problems.push("run is awaiting approval but no gate is");
    }
    const decisions = run.decisions ?? [];
    const askedRequired = decisions.filter((item) => item.required && item.status === "ASKED");
    if (run.status === "awaiting-input" && askedRequired.length === 0) {
        problems.push("run is awaiting input but no required decision is ASKED");
    }
    if (run.status === "running" && decisions.some((item) => item.required && (item.status === "ASKED" || item.status === "PENDING"))) {
        problems.push("run is running with an unanswered required decision");
    }
    if (run.failure !== undefined) {
        problems.push(...failureProblems(run.failure));
        const implied = FAILURE_CODES[run.failure.code]?.status;
        if (implied !== undefined && (run.status === "failed" || run.status === "blocked") && implied !== run.status) {
            problems.push(`failure ${run.failure.code} means the run is ${implied}, not ${run.status}`);
        }
        const phase = run.phases.find((p) => p.phase === run.failure.phase);
        if (phase === undefined || !["failed", "blocked", "running", "pending"].includes(phase.status)) {
            problems.push(`failure names phase ${run.failure.phase}, which did not fail`);
        }
    }
    return problems;
}
function failureProblems(failure, phase) {
    const problems = [];
    const expected = FAILURE_CODES[failure.code]?.retry;
    if (expected !== undefined && failure.retry !== expected) {
        problems.push(`failure ${failure.code} is ${expected}, not ${failure.retry}`);
    }
    if (phase !== undefined && failure.phase !== phase)
        problems.push(`failure recorded on phase ${phase} names phase ${failure.phase}`);
    return problems;
}
/**
 * Problems with the verification plan of a record against the workflow that produced
 * it: every check type the workflow's phases require or recommend, and every evidence
 * kind it requires, is in the plan. Skill requirements are checked separately
 * (assessSkillEvidence); whether the plan was met, by evaluateCompletion.
 */
export function assessWorkflowEvidence(record, workflow) {
    if (record.producer?.workflow !== workflow.id)
        return [`evidence names workflow ${record.producer?.workflow ?? "(none)"}, not ${workflow.id}`];
    const all = (key) => [...new Set(workflow.phases.flatMap((p) => p.verification?.[key] ?? []))];
    return planCoverageProblems(workflow.id, { required: all("required"), recommended: all("recommended") }, workflow.evidence.required, record.plan);
}
