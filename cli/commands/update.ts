import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { generateData, diagnosticsForRun } from "./generate.ts";
import { inspectConsumer, planConsumerUpdate, type ConsumerUpdatePlan } from "../lib/consumer-state.ts";
import { runGenerators, type RunResult } from "../lib/generator-runtime.ts";
import { applyConsumerUpdate } from "../lib/update-transaction.ts";
import { createDiagnostic, createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

function usage(message: string): CommandResult {
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

function plannedGeneratedWrites(generation: RunResult | undefined): string[] {
  if (!generation) return [];
  return [
    ...generation.executions.flatMap((execution) => [...execution.outputs, ...execution.proposals]),
    ".paved/generated/state/last-run.json",
  ].filter((path, index, all) => all.indexOf(path) === index);
}

function updateData(plan: ConsumerUpdatePlan, dryRun: boolean, generation?: RunResult, lifecycleState?: string): Record<string, unknown> {
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
    proposals: generation?.executions.flatMap((execution) => execution.proposals) ?? [],
    conflicts: generation?.executions.filter((execution) => execution.status === "conflict").map((execution) => execution.generator) ?? [],
    ...(generation === undefined ? {} : { generation: generateData(generation, dryRun) }),
  };
}

function writeLock(projectRoot: string, plan: ConsumerUpdatePlan): void {
  if (!plan.nextLock || !plan.plannedWrites.includes(".paved/paved.lock")) return;
  writeFileSync(join(projectRoot, ".paved/paved.lock"), stringify(plan.nextLock));
}

export function updateHandler(invocation: CommandInvocation): CommandResult {
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
    const staged = applyConsumerUpdate(invocation.paths.projectRoot, (stagedRoot) => {
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
          if (!path.startsWith(".paved/generated/proposals/")) continue;
          const source = join(stagedRoot, path);
          if (!existsSync(source)) continue;
          const target = join(invocation.paths.projectRoot, path);
          mkdirSync(join(target, ".."), { recursive: true });
          cpSync(source, target);
        }
      },
    });
    const lifecycleState = inspectConsumer({ projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot }).lifecycleState;
    return createResult({ command: "update", status: statusFor(staged.diagnostics), data: updateData(plan, false, staged.generation, lifecycleState), diagnostics: staged.diagnostics });
  } catch (error) {
    const diagnostic = createDiagnostic({
      severity: "error", category: "generation/update", code: "PAVED_UPDATE_TRANSACTION_FAILED", component: "cli.update",
      message: error instanceof Error ? error.message : "Update transaction failed.",
      remediation: "Inspect .paved.update-backup if present; the previous lock remains authoritative.",
    });
    return createResult({ command: "update", status: "failed", data: updateData(plan, false), diagnostics: [...plan.diagnostics, diagnostic] });
  }
}
