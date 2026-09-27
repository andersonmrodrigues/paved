import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadYaml } from "../lib/documents.ts";
import { initializeConsumer, isIgnoredSourceEntry, planConsumerInitialization, runGenerators } from "../lib/generator-runtime.ts";
import { createRegistry } from "../lib/schemas.ts";
import { createDiagnostic, createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { diagnosticsForRun, generateData } from "./generate.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

function validateExistingState(projectRoot: string, coreRoot: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const registry = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]);
  const checks = [
    { path: join(projectRoot, ".paved/manifest.yaml"), code: "PAVED_MANIFEST_INVALID", component: "consumer.manifest" },
    { path: join(projectRoot, ".paved/paved.lock"), code: "PAVED_LOCK_INVALID", component: "consumer.lock" },
  ];

  for (const check of checks) {
    if (!existsSync(check.path)) continue;
    try {
      const document = loadYaml(check.path);
      const validation = registry.validate(document);
      if (!validation.valid) {
        diagnostics.push(createDiagnostic({
          severity: "error",
          category: "config",
          code: check.code,
          component: check.component,
          message: `${check.path} is invalid: ${validation.errors.join("; ")}`,
          remediation: "Fix the existing Paved state before running init.",
        }));
      }
    } catch {
      diagnostics.push(createDiagnostic({
        severity: "error",
        category: "config",
        code: check.code,
        component: check.component,
        message: `${check.path} cannot be parsed or read.`,
        remediation: "Fix the YAML syntax or file permissions before running init.",
      }));
    }
  }
  return diagnostics;
}

function adapterDiagnostics(diagnostics: ReturnType<typeof planConsumerInitialization>["adapterDiagnostics"]): Diagnostic[] {
  return diagnostics.map((diagnostic) => createDiagnostic({
    severity: "warning",
    category: "findings",
    code: `PAVED_ADAPTER_${diagnostic.code.toUpperCase().replace(/-/g, "_")}`,
    component: "consumer.adapters",
    message: diagnostic.message,
  }));
}

function usage(message: string): CommandResult {
  return createResult({
    command: "init",
    status: "failed",
    diagnostics: [
      createDiagnostic({
        severity: "error",
        category: "usage",
        code: "PAVED_CLI_USAGE",
        component: "cli.init",
        message,
        remediation: "Run paved init without --adapter to initialize from detected repository evidence.",
      }),
    ],
  });
}

export function copyProjectForInitDryRun(projectRoot: string, destination: string): void {
  cpSync(projectRoot, destination, {
    recursive: true,
    filter: (source) => {
      if (source === projectRoot) return true;
      return !isIgnoredSourceEntry(basename(source));
    },
  });
}

export function initDryRunScratchPrefix(tempRoot = tmpdir()): string {
  return join(tempRoot, "paved-init-dry-run-");
}

export function createInitDryRunWorkspace(tempRoot = tmpdir()): string {
  return mkdtempSync(initDryRunScratchPrefix(tempRoot));
}

function planDryRunGeneration(invocation: CommandInvocation, projectName: string) {
  const workspace = createInitDryRunWorkspace();
  const copy = join(workspace, "consumer");
  try {
    copyProjectForInitDryRun(invocation.paths.projectRoot, copy);
    initializeConsumer(invocation.paths.coreRoot, copy, projectName);
    return runGenerators(invocation.paths.coreRoot, copy, { dryRun: true });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function initHandler(invocation: CommandInvocation): CommandResult {
  const pavedDir = join(invocation.paths.projectRoot, ".paved");
  const manifestPath = join(pavedDir, "manifest.yaml");
  const lockPath = join(pavedDir, "paved.lock");
  const existingDiagnostics = validateExistingState(invocation.paths.projectRoot, invocation.paths.coreRoot);
  if (existingDiagnostics.length > 0) {
    return createResult({
      command: "init",
      status: "failed",
      data: { initialized: existsSync(pavedDir), dryRun: invocation.flags.dryRun },
      diagnostics: existingDiagnostics,
    });
  }

  if (existsSync(manifestPath) || existsSync(lockPath) || existsSync(pavedDir)) {
    return createResult({
      command: "init",
      status: "failed",
      data: { initialized: true, dryRun: invocation.flags.dryRun },
      diagnostics: [
        createDiagnostic({
          severity: "error",
          category: "config",
          code: "PAVED_INIT_ALREADY_INITIALIZED",
          component: "cli.init",
          message: "This project already has Paved state; init will not reset or update it.",
          remediation: "Run paved status to inspect the current state or use a future safe update command.",
        }),
      ],
    });
  }

  if (invocation.flags.adapters.length > 0) {
    return usage("init detects adapters from repository evidence; --adapter is not supported for this command.");
  }

  const projectName = basename(invocation.paths.projectRoot);
  const plan = planConsumerInitialization(invocation.paths.coreRoot, invocation.paths.projectRoot, projectName);
  const planningDiagnostics = adapterDiagnostics(plan.adapterDiagnostics);
  if (invocation.flags.dryRun) {
    const generation = invocation.flags.noGenerate ? undefined : planDryRunGeneration(invocation, projectName);
    const diagnostics = generation === undefined ? planningDiagnostics : [...planningDiagnostics, ...diagnosticsForRun(generation, true)];
    const generatedPaths = generation === undefined ? [] : generation.executions.flatMap((execution) => [...execution.outputs, ...execution.proposals]);
    return createResult({
      command: "init",
      status: statusFor(diagnostics),
      data: {
        initialized: false,
        dryRun: true,
        projectName,
        selectedAdapters: plan.selectedAdapters,
        resolvedAdapters: plan.resolvedAdapters,
        plannedWrites: [...plan.plannedWrites, ...generatedPaths, ...(generation === undefined ? [] : [".paved/generated/state/last-run.json"])],
        generate: !invocation.flags.noGenerate,
        ...(generation === undefined ? {} : { generation: generateData(generation, true) }),
      },
      diagnostics,
    });
  }

  initializeConsumer(invocation.paths.coreRoot, invocation.paths.projectRoot, projectName);
  if (invocation.flags.noGenerate) {
    return createResult({
      command: "init",
      status: statusFor(planningDiagnostics),
      data: {
        initialized: true,
        dryRun: false,
        projectName,
        selectedAdapters: plan.selectedAdapters,
        resolvedAdapters: plan.resolvedAdapters,
        generated: false,
      },
      diagnostics: planningDiagnostics,
    });
  }

  const generation = runGenerators(invocation.paths.coreRoot, invocation.paths.projectRoot);
  const diagnostics = [...planningDiagnostics, ...diagnosticsForRun(generation, false)];
  return createResult({
    command: "init",
    status: statusFor(diagnostics),
    data: {
      initialized: true,
      dryRun: false,
      projectName,
      selectedAdapters: plan.selectedAdapters,
      resolvedAdapters: plan.resolvedAdapters,
      generated: true,
      generation: generateData(generation, false),
    },
    diagnostics,
  });
}
