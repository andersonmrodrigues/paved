import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { generateData, diagnosticsForRun } from "./generate.ts";
import { planConsumerUpdate, type ConsumerUpdatePlan } from "../lib/consumer-state.ts";
import { runGenerators, type RunResult } from "../lib/generator-runtime.ts";
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

function updateData(plan: ConsumerUpdatePlan, dryRun: boolean, generation?: RunResult): Record<string, unknown> {
  const generatedWrites = dryRun ? plannedGeneratedWrites(generation).filter((path) => path !== ".paved/generated/state/last-run.json") : plannedGeneratedWrites(generation);
  const plannedWrites = [...plan.plannedWrites, ...generatedWrites].filter((path, index, all) => all.indexOf(path) === index);
  return {
    dryRun,
    changed: plan.changed,
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

function writeLock(invocation: CommandInvocation, plan: ConsumerUpdatePlan): void {
  if (!plan.nextLock) return;
  writeFileSync(join(invocation.paths.projectRoot, ".paved/paved.lock"), stringify(plan.nextLock));
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
    return createResult({
      command: "update",
      status: statusFor(plan.diagnostics),
      data: updateData(plan, invocation.flags.dryRun),
      diagnostics: plan.diagnostics,
    });
  }

  const generation = plan.plannedGeneratorIds.length === 0
    ? undefined
    : runGenerators(invocation.paths.coreRoot, invocation.paths.projectRoot, {
        dryRun: invocation.flags.dryRun,
        generators: [...plan.plannedGeneratorIds],
      });
  const diagnostics = generation === undefined ? plan.diagnostics : [...plan.diagnostics, ...diagnosticsForRun(generation)];
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) {
    return createResult({
      command: "update",
      status: statusFor(diagnostics),
      data: updateData(plan, invocation.flags.dryRun, generation),
      diagnostics,
    });
  }

  if (!invocation.flags.dryRun) {
    writeLock(invocation, plan);
  }

  return createResult({
    command: "update",
    status: statusFor(diagnostics),
    data: updateData(plan, invocation.flags.dryRun, generation),
    diagnostics,
  });
}
