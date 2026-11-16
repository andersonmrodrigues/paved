import { remediationFor } from "../lib/lifecycle-remediation.ts";
import { createDiagnostic, createResult, type CommandResult, type Diagnostic } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { inspectConsumer } from "../lib/consumer-state.ts";
import { outOfScope, resolveTestingTool, runTestingTool, type TestToolOutcome } from "../lib/test-runner.ts";
import { acquireConsumerOperationLock, ConsumerOperationLockedError } from "../lib/operation-lock.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { testingProvider } from "../lib/decisions/providers/testing.ts";
import { ToolInvocationStopped, type ToolInvocationGuard } from "../lib/tools.ts";
import { testingHandler } from "../lib/decisions/handlers/testing.ts";

function statusFor(diagnostics: readonly Diagnostic[], failed: boolean): "success" | "warning" | "failed" {
  if (failed || diagnostics.some((item) => item.severity === "error")) return "failed";
  return diagnostics.length > 0 ? "warning" : "success";
}

const describe = (item: TestToolOutcome): string => `${item.tool} in ${item.workingDirectory}${item.evidence ? ` (${item.evidence})` : ""}`;

/**
 * Names each Tool that did not pass, so a suite failure says which modules to look at. A
 * Tool that ran out of time is reported apart from one whose tests failed: the fix for it
 * is a faster suite or a longer limit, not a code change.
 */
function failureDiagnostics(outcomes: readonly TestToolOutcome[] | undefined): Diagnostic[] {
  const all = outcomes ?? [];
  const ran = all.filter((item) => item.status !== "skipped");
  const timedOut = all.filter((item) => item.status === "timed-out");
  const failing = all.filter((item) => item.status !== "passed" && item.status !== "skipped" && item.status !== "timed-out");
  const diagnostics: Diagnostic[] = [];
  if (timedOut.length > 0) {
    const list = timedOut.map((item) => `${describe(item)} after ${item.timeoutSeconds ?? "its"} seconds`).join("; ");
    diagnostics.push(createDiagnostic({
      severity: "error", category: "verification", code: "PAVED_TEST_TOOL_TIMED_OUT", component: "cli.commands.test",
      message: ran.length < 2 ? `The declared testing Tool timed out: ${list}.` : `${timedOut.length} of ${ran.length} testing Tools timed out: ${list}.`,
      remediation: "Make the tests finish sooner, or raise timeout_seconds on the Tool contract and its ToolImplementation (the binding may lower the contract's limit, never exceed it).",
    }));
  }
  if (failing.length > 0 || timedOut.length === 0) {
    diagnostics.push(createDiagnostic({
      severity: "error", category: "verification", code: "PAVED_TEST_TOOL_FAILED", component: "cli.commands.test",
      message: failing.length === 0 || ran.length < 2 ? "The declared testing Tool failed."
        : `${failing.length} of ${ran.length} testing Tools failed: ${failing.map(describe).join("; ")}.`,
      remediation: "Inspect the recorded Tool result and sanitized evidence log, then address the test failure.",
    }));
  }
  return diagnostics;
}

export async function testHandler(invocation: CommandInvocation, beforeRun?: ToolInvocationGuard, scope: { changedFiles?: readonly string[] } = {}): Promise<CommandResult> {
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
    sourceRoot: invocation.paths.sourceRoot,
    coreRoot: invocation.paths.coreRoot,
  }).lifecycleState;
  if (!["RESOLVED", "GENERATED", "VALIDATED", "READY"].includes(lifecycle)) {
    const remediation = remediationFor(lifecycle);
    return createResult({
      command: "test",
      status: "failed",
      ...(remediation ? { data: { remediation } } : {}),
      diagnostics: [createDiagnostic({
        severity: "error",
        category: "config",
        code: "PAVED_TEST_LIFECYCLE_BLOCKED",
        component: "cli.commands.test",
        message: `Testing requires an initialized and resolved Paved consumer; current lifecycle is ${lifecycle}.`,
        remediation: remediation ? `Run ${remediation.command}, then repeat this command.` : "Run paved status and resolve the reported state before executing a testing Tool.",
      })],
    });
  }

  try {
    const outcome = runDecisionGate({
      context: {
        projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
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
      const selected = resolveTestingTool(invocation.paths.projectRoot, invocation.paths.coreRoot, invocation.paths.sourceRoot);
      if (beforeRun && (selected.status === "resolved" || selected.status === "suite")) {
        const skipped = outOfScope(selected, scope.changedFiles);
        const running = (selected.status === "suite" ? selected.members : [selected]).filter((member) => !skipped.has(member.tool.id));
        const stopped = beforeRun(running.map((member) => ({ ...member, inputs })));
        if (stopped) return stopped;
      }
      const result = await runTestingTool({
        projectRoot: invocation.paths.projectRoot,
        sourceRoot: invocation.paths.sourceRoot,
        coreRoot: invocation.paths.coreRoot,
        inputs,
        ...(scope.changedFiles === undefined ? {} : { changedFiles: scope.changedFiles }),
      }, selected);
      return createResult({
        command: "test",
        status: statusFor(result.diagnostics, result.status === "failed"),
        data: {
          lifecycleState: lifecycle,
          tool: result.tool,
          evidence: result.evidence,
          ...(result.tools === undefined ? {} : { tools: result.tools }),
          ...(result.evidences === undefined ? {} : { evidences: result.evidences }),
          ...(result.outcomes === undefined ? {} : { outcomes: result.outcomes }),
          verification: "not-run",
        },
        diagnostics: [
          ...result.diagnostics,
          ...(result.status === "failed" && result.diagnostics.length === 0 ? failureDiagnostics(result.outcomes) : []),
        ],
      });
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof ToolInvocationStopped) throw error;
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
          remediation: error.remediation,
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
