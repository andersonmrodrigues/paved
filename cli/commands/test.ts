import { createDiagnostic, createResult, type CommandResult, type Diagnostic } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer } from "../lib/consumer-state.ts";
import { runTestingTool } from "../lib/test-runner.ts";
import { acquireConsumerOperationLock, ConsumerOperationLockedError } from "../lib/operation-lock.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { testingProvider } from "../lib/decisions/providers/testing.ts";
import { testingHandler } from "../lib/decisions/handlers/testing.ts";

function statusFor(diagnostics: readonly Diagnostic[], failed: boolean): "success" | "warning" | "failed" {
  if (failed || diagnostics.some((item) => item.severity === "error")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

export async function testHandler(invocation: CommandInvocation): Promise<CommandResult> {
  let inputs: Record<string, unknown> = {};
  if (invocation.flags.inputs !== undefined) {
    try {
      const parsed: unknown = JSON.parse(invocation.flags.inputs);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
      inputs = parsed as Record<string, unknown>;
    } catch (error) {
      return createResult({
        command: "test",
        status: "failed",
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "usage",
          code: "PAVED_TEST_INPUTS_INVALID",
          component: "cli.commands.test",
          message: error instanceof Error ? `--inputs must be a JSON object: ${error.message}` : "--inputs must be a JSON object.",
          remediation: "Pass Tool inputs as one JSON object, for example --inputs '{\"scope\":\"src\"}'.",
        })],
      });
    }
  }

  const lifecycle = inspectConsumer({
    projectRoot: invocation.paths.projectRoot,
    coreRoot: invocation.paths.coreRoot,
  }).lifecycleState;
  if (!["RESOLVED", "GENERATED", "VALIDATED", "READY"].includes(lifecycle)) {
    return createResult({
      command: "test",
      status: "failed",
      diagnostics: [createDiagnostic({
        severity: "error",
        category: "config",
        code: "PAVED_TEST_LIFECYCLE_BLOCKED",
        component: "cli.commands.test",
        message: `Testing requires an initialized and resolved Paved consumer; current lifecycle is ${lifecycle}.`,
        remediation: "Run paved init and resolve the project before executing a testing Tool.",
      })],
    });
  }

  try {
    const outcome = runDecisionGate({
      context: {
        projectRoot: invocation.paths.projectRoot, coreRoot: invocation.paths.coreRoot,
        command: "test", answers: invocation.flags.answers,
        ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
      },
      providers: [testingProvider], handlers: new Map([["testing.select", testingHandler]]),
      persist: true,
    });
    if (outcome.problems.length > 0) {
      return createResult({
        command: "test", status: "failed", decisions: outcome.projections,
        diagnostics: outcome.problems.map((message) => createDiagnostic({
          severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
          component: "cli.commands.test", message,
        })),
      });
    }
    if (outcome.status === "awaiting-input") {
      return createResult({ command: "test", status: "awaiting_input", decisions: outcome.projections });
    }
    const release = acquireConsumerOperationLock(invocation.paths.projectRoot, "test");
    try {
      const result = await runTestingTool({
        projectRoot: invocation.paths.projectRoot,
        coreRoot: invocation.paths.coreRoot,
        inputs,
      });
      return createResult({
        command: "test",
        status: statusFor(result.diagnostics, result.status === "failed"),
        data: {
          lifecycleState: lifecycle,
          tool: result.tool,
          evidence: result.evidence,
          ...(result.tools === undefined ? {} : { tools: result.tools }),
          ...(result.evidences === undefined ? {} : { evidences: result.evidences }),
          verification: "not-run",
        },
        diagnostics: [
          ...result.diagnostics,
          ...(result.status === "failed" && result.diagnostics.length === 0
            ? [createDiagnostic({
                severity: "error",
                category: "verification",
                code: "PAVED_TEST_TOOL_FAILED",
                component: "cli.commands.test",
                message: "The declared testing Tool failed or timed out.",
                remediation: "Inspect the recorded Tool result and sanitized evidence log, then address the test failure.",
              })]
            : []),
        ],
      });
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof ConsumerOperationLockedError) {
      return createResult({
        command: "test",
        status: "failed",
        diagnostics: [createDiagnostic({
          severity: "error",
          category: "conflict",
          code: "PAVED_OPERATION_IN_PROGRESS",
          component: "consumer.operation",
          message: error.message,
          remediation: "Wait for the active Paved operation to finish before running tests.",
        })],
      });
    }
    return createResult({
      command: "test",
      status: "failed",
      diagnostics: [createDiagnostic({
        severity: "error",
        category: "internal",
        code: "PAVED_TEST_RUNNER_FAILED",
        component: "cli.commands.test",
        message: error instanceof Error ? error.message : "Testing Tool execution failed unexpectedly.",
      })],
    });
  }
}
