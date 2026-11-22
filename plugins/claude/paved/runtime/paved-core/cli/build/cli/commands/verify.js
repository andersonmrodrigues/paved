import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, sep } from "node:path";
import { ToolInvocationStopped } from "../lib/tools.js";
import { runVerification } from "../lib/verification-runner.js";
import { mergeBase, resolveCommit } from "../lib/workflow-evidence.js";
import { ConsumerOperationLockedError } from "../lib/operation-lock.js";
import { runDecisionGate } from "../lib/decisions/gate.js";
import { verificationProvider } from "../lib/decisions/providers/verification.js";
import { verificationHandler } from "../lib/decisions/handlers/verification.js";
import { attachTaskEvidence, resumeTask } from "../lib/task-handoff.js";
import { createDiagnostic, createResult } from "../result.js";
function statusFor(diagnostics) {
    if (diagnostics.some((diagnostic) => diagnostic.category !== "findings"))
        return "failed";
    return diagnostics.length > 0 ? "warning" : "success";
}
// The runner reports real paths; a symlinked project root (macOS /var -> /private/var) must not turn them into ../ paths.
function rel(projectRoot, path) {
    return relative(realpathSync(projectRoot), realpathSync(path)).split(sep).join("/");
}
export async function verifyHandler(invocation, beforeRun, scope = {}) {
    let result;
    const task = invocation.flags.task;
    if (task !== undefined) {
        try {
            if (resumeTask(invocation.paths.projectRoot, task).status !== "open")
                throw new Error("Task is already done.");
        }
        catch (error) {
            return createResult({ command: "verify", status: "failed", diagnostics: [createDiagnostic({
                        severity: "error", category: "config", code: "PAVED_VERIFY_TASK_INVALID", component: "cli.commands.verify",
                        message: error instanceof Error ? error.message : "Cannot access task.",
                    })] });
        }
    }
    try {
        let changedFiles = scope.changedFiles;
        let baseRevision;
        if (invocation.flags.changed) {
            const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], {
                cwd: invocation.paths.sourceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
            });
            if (status.error || status.status !== 0) {
                return createResult({
                    command: "verify", status: "failed",
                    diagnostics: [createDiagnostic({
                            severity: "error", category: "environment", code: "PAVED_VERIFY_CHANGE_SCOPE_UNAVAILABLE",
                            component: "cli.commands.verify", message: "Cannot determine changed files from Git.",
                            remediation: "Run without --changed or use a Git working tree.",
                        })],
                });
            }
            const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
                cwd: invocation.paths.sourceRoot, encoding: "utf8", maxBuffer: 64 * 1024,
            });
            if (top.error || top.status !== 0)
                return createResult({
                    command: "verify", status: "failed", diagnostics: [createDiagnostic({
                            severity: "error", category: "environment", code: "PAVED_VERIFY_CHANGE_SCOPE_UNAVAILABLE",
                            component: "cli.commands.verify", message: "Cannot determine the Git working tree root.",
                        })],
                });
            const prefix = relative(realpathSync(top.stdout.replace(/\n$/, "")), realpathSync(invocation.paths.sourceRoot)).split(sep).join("/");
            const paths = status.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3))
                .filter((path) => !prefix || path.startsWith(`${prefix}/`))
                .map((path) => prefix ? path.slice(prefix.length + 1) : path);
            if (invocation.flags.base !== undefined) {
                const head = resolveCommit(invocation.paths.sourceRoot, "HEAD");
                const target = resolveCommit(invocation.paths.sourceRoot, invocation.flags.base);
                const base = head && target ? mergeBase(invocation.paths.sourceRoot, head, target) : undefined;
                if (!base)
                    return createResult({
                        command: "verify", status: "failed", diagnostics: [createDiagnostic({
                                severity: "error", category: "usage", code: "PAVED_VERIFY_BASE_INVALID", component: "cli.commands.verify",
                                message: "The requested base and HEAD must be commits with a common ancestor.",
                            })],
                    });
                baseRevision = base;
                const diff = spawnSync("git", ["diff", "--name-only", "-z", "--no-renames", "--relative", base], {
                    cwd: invocation.paths.sourceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
                });
                if (diff.error || diff.status !== 0)
                    return createResult({
                        command: "verify", status: "failed", diagnostics: [createDiagnostic({
                                severity: "error", category: "environment", code: "PAVED_VERIFY_CHANGE_SCOPE_UNAVAILABLE",
                                component: "cli.commands.verify", message: "Cannot determine changed files from Git.",
                            })],
                    });
                paths.push(...diff.stdout.split("\0").filter(Boolean));
            }
            const configurationChanged = paths.some((path) => path.startsWith(".paved/") &&
                !path.startsWith(".paved/generated/") && !path.startsWith(".paved/tasks/"));
            changedFiles = configurationChanged ? undefined : [...new Set(paths)]
                .filter((path) => path !== ".paved" && !path.startsWith(".paved/") &&
                path !== ".paved-operation-lock" && !path.startsWith(".paved.update-backup/"));
        }
        const outcome = runDecisionGate({
            context: {
                projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot,
                coreRoot: invocation.paths.coreRoot,
                command: "verify",
                answers: invocation.flags.answers,
                ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
            },
            providers: [verificationProvider],
            handlers: new Map([["verification.adopt", verificationHandler]]),
            persist: true,
        });
        if (outcome.problems.length > 0) {
            return createResult({
                command: "verify", status: "failed", decisions: outcome.projections,
                diagnostics: outcome.problems.map((message) => createDiagnostic({
                    severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
                    component: "cli.commands.verify", message,
                    remediation: "Answer with one of the offered option ids.",
                })),
            });
        }
        if (outcome.status === "awaiting-input") {
            return createResult({ command: "verify", status: "awaiting_input", decisions: outcome.projections });
        }
        result = await runVerification({
            projectRoot: invocation.paths.projectRoot,
            sourceRoot: invocation.paths.sourceRoot,
            coreRoot: invocation.paths.coreRoot,
            adapterSelections: invocation.flags.adapters,
            ...(changedFiles === undefined ? {} : { changedFiles }),
            ...(baseRevision === undefined ? {} : { baseRevision }),
            ...(invocation.flags.lockWaitSeconds === undefined ? {} : { lockWaitMs: invocation.flags.lockWaitSeconds * 1000 }),
            ...(beforeRun ? { beforeRun: (selected) => {
                    const stopped = beforeRun(selected);
                    if (stopped)
                        throw new ToolInvocationStopped(stopped);
                } } : {}),
        });
    }
    catch (error) {
        if (!(error instanceof ConsumerOperationLockedError))
            throw error;
        return createResult({
            command: "verify",
            status: "failed",
            diagnostics: [{
                    severity: "error",
                    category: "conflict",
                    code: "PAVED_OPERATION_IN_PROGRESS",
                    component: "consumer.operation",
                    message: error.message,
                    remediation: error.remediation,
                }],
        });
    }
    const evidence = result.evidenceFiles.map((file) => rel(invocation.paths.projectRoot, file));
    if (task !== undefined) {
        try {
            attachTaskEvidence(invocation.paths.projectRoot, task, `Verification ${result.status}: ${evidence.length ? evidence.join(", ") : "no evidence recorded"}`);
        }
        catch (error) {
            return createResult({ command: "verify", status: "failed", data: { checks: result.checks, evidence },
                diagnostics: [...result.diagnostics, createDiagnostic({
                        severity: "error", category: "conflict", code: "PAVED_VERIFY_TASK_EVIDENCE_FAILED", component: "cli.commands.verify",
                        message: error instanceof Error ? error.message : "Cannot attach task evidence.",
                    })] });
        }
    }
    return createResult({
        command: "verify",
        status: statusFor(result.diagnostics),
        data: {
            checks: result.checks,
            evidence,
            ...(result.reused ? { reused: true } : {}),
            ...(result.unproven === undefined ? {} : { unproven: result.unproven }),
            completion: result.evaluation === undefined
                ? undefined
                : {
                    status: result.evaluation.status,
                    verification: result.evaluation.verification,
                    blocking: result.evaluation.blocking,
                    warnings: result.evaluation.warnings,
                },
        },
        diagnostics: result.diagnostics,
    });
}
