import { runGenerators, type Execution, type RunResult } from "../lib/generator-runtime.ts";
import { createDiagnostic, createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

export function diagnosticsForRun(result: RunResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const diagnostic of result.adapterDiagnostics) {
    diagnostics.push(createDiagnostic({
      severity: "warning",
      category: "findings",
      code: `PAVED_ADAPTER_${diagnostic.code.toUpperCase().replace(/-/g, "_")}`,
      component: "consumer.adapters",
      message: diagnostic.message,
    }));
  }
  for (const execution of result.executions) {
    if (execution.status === "conflict") {
      diagnostics.push(createDiagnostic({
        severity: "error",
        category: "conflict",
        code: "PAVED_GENERATOR_CONFLICT",
        component: `generator.${execution.generator}`,
        message: `Generator ${execution.generator} produced a conflict and wrote a proposal instead of overwriting a human-edited artifact.`,
        remediation: "Review the proposal under .paved/generated/proposals and reconcile the human-owned generated document.",
      }));
    }
    for (const error of execution.errors) {
      diagnostics.push(createDiagnostic({
        severity: "error",
        category: "generation/update",
        code: "PAVED_GENERATOR_FAILED",
        component: `generator.${execution.generator}`,
        message: error,
      }));
    }
  }
  for (const error of result.errors) {
    if (/^Unknown generator selector: /.test(error)) {
      diagnostics.push(createDiagnostic({
        severity: "error",
        category: "usage",
        code: "PAVED_GENERATOR_SELECTOR_UNKNOWN",
        component: "cli.generate",
        message: error,
        remediation: "Use a generator id from the local Core, such as project-context/architecture.",
      }));
      continue;
    }
    if (result.executions.every((execution) => !execution.errors.some((entry) => error.endsWith(entry)))) {
      diagnostics.push(createDiagnostic({
        severity: "error",
        category: "generation/update",
        code: "PAVED_GENERATOR_RUNTIME_FAILED",
        component: "cli.generate",
        message: error,
      }));
    }
  }
  return diagnostics;
}

function summarizeExecution(execution: Execution): Record<string, unknown> {
  return {
    generator: execution.generator,
    version: execution.version,
    status: execution.status,
    outputs: execution.outputs,
    proposals: execution.proposals,
    warnings: execution.warnings,
    errors: execution.errors,
  };
}

export function generateData(result: RunResult, dryRun: boolean): Record<string, unknown> {
  return {
    dryRun,
    executionId: result.executionId,
    coreVersion: result.coreVersion,
    selectedAdapters: result.selectedAdapters,
    adapterWarnings: result.adapterWarnings,
    executions: result.executions.map(summarizeExecution),
    proposals: result.executions.flatMap((execution) => execution.proposals),
    conflicts: result.executions.filter((execution) => execution.status === "conflict").map((execution) => execution.generator),
    errors: result.errors,
  };
}

export function generateHandler(invocation: CommandInvocation): CommandResult {
  if (invocation.flags.adapters.length > 0) {
    return createResult({
      command: "generate",
      status: "failed",
      diagnostics: [
        createDiagnostic({
          severity: "error",
          category: "usage",
          code: "PAVED_CLI_USAGE",
          component: "cli.generate",
          message: "generate uses the adapters declared in .paved/manifest.yaml; --adapter is not supported for this command.",
          remediation: "Edit .paved/manifest.yaml intentionally before running generate.",
        }),
      ],
    });
  }

  const result = runGenerators(invocation.paths.coreRoot, invocation.paths.projectRoot, {
    dryRun: invocation.flags.dryRun,
    ...(invocation.selectors.length === 0 ? {} : { generators: [...invocation.selectors] }),
  });
  const diagnostics = diagnosticsForRun(result);
  return createResult({
    command: "generate",
    status: statusFor(diagnostics),
    data: generateData(result, invocation.flags.dryRun),
    diagnostics,
  });
}
