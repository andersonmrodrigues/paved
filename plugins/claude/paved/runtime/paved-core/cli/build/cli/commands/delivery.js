import { spawnSync } from "node:child_process";
import { deliveryApprovalPath, deliveryApprovalProblem, readDeliveryApproval, writeDeliveryApproval } from "../lib/delivery-approval.js";
import { statusHandler } from "./status.js";
import { createDiagnostic, createResult } from "../result.js";
function failure(code, category, message, remediation) {
    return createResult({
        command: "delivery",
        status: category === "findings" ? "warning" : "failed",
        diagnostics: [createDiagnostic({
                severity: category === "findings" ? "warning" : "error", category, code, component: "delivery", message,
                ...(remediation === undefined ? {} : { remediation }),
            })],
    });
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requiredInputs(invocation) {
    const { base, change, head } = invocation.flags;
    if (base === undefined || !/^(?!-)[^\s]+$/.test(base)) {
        return failure("PAVED_DELIVERY_USAGE", "usage", "Delivery requires --base <target>.", "Name the change request's target branch.");
    }
    if (change === undefined || !/^(?!-)[^\s]+$/.test(change)) {
        return failure("PAVED_DELIVERY_USAGE", "usage", "Delivery requires --change <id>.");
    }
    if (head === undefined || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head)) {
        return failure("PAVED_DELIVERY_USAGE", "usage", "Delivery requires --head <full-revision>.");
    }
    return { target: base, change, head };
}
function currentReadiness(invocation, target, dependencies) {
    if (dependencies.readiness !== undefined)
        return dependencies.readiness(invocation, target);
    const result = statusHandler({
        ...invocation,
        command: "status",
        selectors: [],
        flags: { ...invocation.flags, base: target },
    });
    const data = isRecord(result.data) ? result.data : undefined;
    const delivery = data !== undefined && isRecord(data.delivery) ? data.delivery : undefined;
    if (delivery?.ready !== true || result.diagnostics.some((item) => item.category !== "findings" && item.severity !== "info")) {
        const reason = delivery?.reason
            ?? result.diagnostics.find((item) => item.severity === "error")?.message
            ?? "Paved has no current, completed verification and independent-review evidence for this change.";
        return failure("PAVED_DELIVERY_NOT_READY", "findings", reason, "Complete verification and independent review, then run paved status --base <target> --json.");
    }
    if (typeof delivery.headPatchId !== "string" || delivery.headPatchId !== delivery.recordedPatchId || delivery.uncommitted !== false) {
        return failure("PAVED_DELIVERY_NOT_READY", "findings", "The current target patch does not exactly match the completed run's verified and reviewed patch.", "Run paved status --base <target> --json and refresh evidence for the current patch.");
    }
    return delivery;
}
function runProcess(dependencies, command, args, cwd) {
    return dependencies.run?.(command, args, cwd)
        ?? spawnSync(command, [...args], { cwd, encoding: "utf8", shell: false, timeout: 120_000 });
}
function gitHead(invocation, dependencies) {
    const result = runProcess(dependencies, "git", ["rev-parse", "HEAD"], invocation.paths.sourceRoot);
    const head = result.stdout.trim();
    if (result.error || result.status !== 0 || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head)) {
        return failure("PAVED_DELIVERY_GIT_FAILED", "environment", `Cannot determine the current Git head${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`, "Run this command from the checkout that contains the change request.");
    }
    return head;
}
function remoteHead(invocation, dependencies, action) {
    const result = runProcess(dependencies, "gh", ["pr", "view", action.change, "--json", "baseRefName,headRefOid"], invocation.paths.sourceRoot);
    if (result.error || result.status !== 0) {
        return failure("PAVED_DELIVERY_CHANGE_REQUEST_UNAVAILABLE", "environment", `Cannot read change request ${action.change}${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`, "Authenticate with the repository host and confirm the change request exists.");
    }
    let remote;
    try {
        remote = JSON.parse(result.stdout);
    }
    catch {
        return failure("PAVED_DELIVERY_STATUS_INVALID", "environment", "The repository host returned invalid change-request status.");
    }
    if (!isRecord(remote) || remote.baseRefName !== action.target || remote.headRefOid !== action.head) {
        return failure("PAVED_DELIVERY_HEAD_MISMATCH", "findings", "The change request's target or head differs from the exact action being approved.", "Read the change request status again and confirm its target and full head revision before proceeding.");
    }
    return undefined;
}
function actionFor(inputs, readiness) {
    if (readiness.headPatchId === undefined) {
        return failure("PAVED_DELIVERY_NOT_READY", "findings", "Paved could not fingerprint the current target patch.");
    }
    return { ...inputs, patch_id: readiness.headPatchId };
}
export function deliveryHandler(invocation, dependencies = {}) {
    const [operation] = invocation.selectors;
    if (invocation.selectors.length !== 1 || (operation !== "approve" && operation !== "merge")) {
        return failure("PAVED_DELIVERY_USAGE", "usage", "Use paved delivery approve|merge --base <target> --change <id> --head <full-revision>.");
    }
    const inputs = requiredInputs(invocation);
    if ("command" in inputs)
        return inputs;
    const readiness = currentReadiness(invocation, inputs.target, dependencies);
    if ("command" in readiness)
        return readiness;
    const expectedAction = actionFor(inputs, readiness);
    if ("command" in expectedAction)
        return expectedAction;
    const head = gitHead(invocation, dependencies);
    if (typeof head !== "string")
        return head;
    if (head !== inputs.head) {
        return failure("PAVED_DELIVERY_HEAD_MISMATCH", "findings", "The supplied head revision is not the current checkout's HEAD.", "Read the current head revision and repeat the explicit confirmation for that exact revision.");
    }
    const remoteProblem = remoteHead(invocation, dependencies, inputs);
    if (remoteProblem !== undefined)
        return remoteProblem;
    if (operation === "approve") {
        try {
            const written = writeDeliveryApproval(invocation.paths.projectRoot, expectedAction, invocation.paths.coreRoot);
            return createResult({
                command: "delivery",
                status: "success",
                data: {
                    target: expectedAction.target,
                    change: expectedAction.change,
                    head: expectedAction.head,
                    patch_id: expectedAction.patch_id,
                    approval: written.path,
                    approved_by: written.approval.approved_by,
                    approved_at: written.approval.approved_at,
                    nextAction: `paved delivery merge --base ${expectedAction.target} --change ${expectedAction.change} --head ${expectedAction.head} --json`,
                },
            });
        }
        catch (error) {
            return failure("PAVED_DELIVERY_APPROVAL_FAILED", "config", error instanceof Error ? error.message : "Cannot record delivery approval.");
        }
    }
    let approval;
    const path = deliveryApprovalPath(expectedAction);
    try {
        approval = readDeliveryApproval(invocation.paths.projectRoot, invocation.paths.coreRoot, path);
    }
    catch (error) {
        return failure("PAVED_DELIVERY_APPROVAL_REQUIRED", "findings", error instanceof Error ? error.message : "A matching human delivery approval is required.", `After the user confirms this exact target, change request and head, run paved delivery approve --base ${expectedAction.target} --change ${expectedAction.change} --head ${expectedAction.head}.`);
    }
    const approvalProblem = deliveryApprovalProblem(approval, expectedAction, invocation.paths.coreRoot);
    if (approvalProblem !== undefined) {
        return failure("PAVED_DELIVERY_APPROVAL_INVALID", "findings", approvalProblem);
    }
    const merged = runProcess(dependencies, "gh", ["pr", "merge", expectedAction.change, "--squash", "--match-head-commit", expectedAction.head], invocation.paths.sourceRoot);
    if (merged.error || merged.status !== 0) {
        return failure("PAVED_DELIVERY_MERGE_FAILED", "environment", `The repository host refused the merge${merged.stderr.trim() ? `: ${merged.stderr.trim()}` : "."}`, "Read the change request status; do not retry automatically or approve a moved head.");
    }
    return createResult({
        command: "delivery",
        status: "success",
        data: {
            target: expectedAction.target,
            change: expectedAction.change,
            head: expectedAction.head,
            patch_id: expectedAction.patch_id,
            approval: path,
            output: merged.stdout.trim(),
        },
    });
}
