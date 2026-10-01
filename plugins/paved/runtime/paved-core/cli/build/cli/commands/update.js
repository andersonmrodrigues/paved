import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { generateData, diagnosticsForRun } from "./generate.js";
import { inspectConsumer, planConsumerUpdate } from "../lib/consumer-state.js";
import { runGenerators } from "../lib/generator-runtime.js";
import { applyConsumerUpdate } from "../lib/update-transaction.js";
import { ConsumerOperationLockedError } from "../lib/operation-lock.js";
import { applyDocumentMigrations } from "../lib/document-migrations.js";
import { createRegistry } from "../lib/schemas.js";
import { createDiagnostic, createResult } from "../result.js";
function statusFor(diagnostics) {
    if (diagnostics.some((diagnostic) => diagnostic.category !== "findings"))
        return "failed";
    return diagnostics.length > 0 ? "warning" : "success";
}
function usage(message) {
    return createResult({
        command: "update",
        status: "failed",
        diagnostics: [
            createDiagnostic({
                severity: "error",
                category: "usage",
                code: "PAVED_CLI_USAGE",
                component: "cli.update",
                message,
                remediation: "Edit .paved/manifest.yaml intentionally before running update; remote and adapter override resolution are not supported.",
            }),
        ],
    });
}
function plannedGeneratedWrites(generation) {
    if (!generation)
        return [];
    return [
        ...generation.executions.flatMap((execution) => [...execution.outputs, ...execution.proposals]),
        ".paved/generated/state/last-run.json",
    ].filter((path, index, all) => all.indexOf(path) === index);
}
function updateData(plan, dryRun, generation, lifecycleState) {
    const generatedWrites = dryRun ? plannedGeneratedWrites(generation).filter((path) => path !== ".paved/generated/state/last-run.json") : plannedGeneratedWrites(generation);
    const plannedWrites = [...plan.plannedWrites, ...generatedWrites].filter((path, index, all) => all.indexOf(path) === index);
    return {
        dryRun,
        changed: plan.changed,
        ...(lifecycleState === undefined ? {} : { lifecycleState }),
        compatibility: plan.compatibility ?? "unknown",
        remoteResolution: plan.remoteResolution,
        selectedAdapters: plan.selectedAdapters,
        resolvedAdapters: plan.resolvedAdapters,
        plannedWrites,
        plannedGeneratorIds: plan.plannedGeneratorIds,
        migrations: plan.plannedMigrations,
        proposals: generation?.executions.flatMap((execution) => execution.proposals) ?? [],
        conflicts: generation?.executions.filter((execution) => execution.status === "conflict").map((execution) => execution.generator) ?? [],
        ...(generation === undefined ? {} : { generation: generateData(generation, dryRun) }),
    };
}
function writeLock(projectRoot, plan) {
    if (!plan.nextLock || !plan.plannedWrites.includes(".paved/paved.lock"))
        return;
    atomicWriteFileSync(join(projectRoot, ".paved/paved.lock"), stringify(plan.nextLock));
}
export function updateHandler(invocation) {
    if (invocation.flags.adapters.length > 0) {
        return usage("update uses the adapters declared in .paved/manifest.yaml; --adapter is not supported for this command.");
    }
    const plan = planConsumerUpdate({
        projectRoot: invocation.paths.projectRoot,
        coreRoot: invocation.paths.coreRoot,
        ...(invocation.paths.manifestPath === undefined ? {} : { manifestPath: invocation.paths.manifestPath }),
    });
    if (plan.diagnostics.some((diagnostic) => diagnostic.category !== "findings")) {
        return createResult({
            command: "update",
            status: statusFor(plan.diagnostics),
            data: updateData(plan, invocation.flags.dryRun),
            diagnostics: plan.diagnostics,
        });
    }
    if (!plan.changed) {
        const lifecycleState = inspectConsumer({ projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot }).lifecycleState;
        return createResult({
            command: "update",
            status: statusFor(plan.diagnostics),
            data: updateData(plan, invocation.flags.dryRun, undefined, lifecycleState),
            diagnostics: plan.diagnostics,
        });
    }
    if (invocation.flags.dryRun) {
        const generation = plan.plannedGeneratorIds.length === 0 ? undefined : runGenerators(invocation.paths.coreRoot, invocation.paths.projectRoot, {
            dryRun: true,
            generators: [...plan.plannedGeneratorIds],
            ...(plan.nextLock === undefined ? {} : { lock: plan.nextLock }),
        });
        const diagnostics = generation === undefined ? plan.diagnostics : [...plan.diagnostics, ...diagnosticsForRun(generation, true)];
        return createResult({ command: "update", status: statusFor(diagnostics), data: updateData(plan, true, generation), diagnostics });
    }
    try {
        const registry = createRegistry(join(invocation.paths.coreRoot, "schemas"), ["paved/v1"]);
        const staged = applyConsumerUpdate(invocation.paths.projectRoot, (stagedRoot) => {
            applyDocumentMigrations(stagedRoot, plan.plannedMigrations, registry);
            const generation = plan.plannedGeneratorIds.length === 0 ? undefined : runGenerators(invocation.paths.coreRoot, stagedRoot, {
                generators: [...plan.plannedGeneratorIds],
                ...(plan.nextLock === undefined ? {} : { lock: plan.nextLock }),
            });
            const diagnostics = generation === undefined ? [...plan.diagnostics] : [...plan.diagnostics, ...diagnosticsForRun(generation)];
            if (diagnostics.every((item) => item.category === "findings")) {
                writeLock(stagedRoot, plan);
                const inspection = inspectConsumer({ projectRoot: stagedRoot, coreRoot: invocation.paths.coreRoot });
                diagnostics.push(...inspection.diagnostics.filter((item) => item.category !== "findings"));
            }
            return { generation, diagnostics };
        }, {
            commitIf: (result) => result.diagnostics.every((item) => item.category === "findings"),
            onRejected: (stagedRoot, result) => {
                for (const path of result.generation?.executions.flatMap((execution) => execution.proposals) ?? []) {
                    if (!path.startsWith(".paved/generated/proposals/"))
                        continue;
                    const source = join(stagedRoot, path);
                    if (!existsSync(source))
                        continue;
                    const target = join(invocation.paths.projectRoot, path);
                    mkdirSync(join(target, ".."), { recursive: true });
                    cpSync(source, target);
                }
            },
        });
        const lifecycleState = inspectConsumer({ projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot }).lifecycleState;
        return createResult({ command: "update", status: statusFor(staged.diagnostics), data: updateData(plan, false, staged.generation, lifecycleState), diagnostics: staged.diagnostics });
    }
    catch (error) {
        if (error instanceof ConsumerOperationLockedError) {
            const diagnostic = createDiagnostic({
                severity: "error", category: "conflict", code: "PAVED_OPERATION_IN_PROGRESS", component: "consumer.operation",
                message: error.message,
                remediation: "Wait for the active operation to finish. For a stale lock, confirm no Paved process is active before removing .paved-operation-lock.",
            });
            return createResult({ command: "update", status: "failed", data: updateData(plan, false), diagnostics: [...plan.diagnostics, diagnostic] });
        }
        const diagnostic = createDiagnostic({
            severity: "error", category: "generation/update", code: "PAVED_UPDATE_TRANSACTION_FAILED", component: "cli.update",
            message: error instanceof Error ? error.message : "Update transaction failed.",
            remediation: "Inspect .paved.update-backup if present; the previous lock remains authoritative.",
        });
        return createResult({ command: "update", status: "failed", data: updateData(plan, false), diagnostics: [...plan.diagnostics, diagnostic] });
    }
}
