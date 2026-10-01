#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { renderHuman, renderJson } from "./output.ts";
import { createDiagnostic, createResult, exitCode, type CommandResult } from "./result.ts";
import { dispatchCli } from "./runtime.ts";

function outputMode(argv: readonly string[]): "json" | "human" {
  return argv.includes("--json") ? "json" : "human";
}

function internalResult(error: unknown): CommandResult {
  return createResult({
    command: "cli",
    status: "failed",
    diagnostics: [
      createDiagnostic({
        severity: "error",
        category: "internal",
        code: "PAVED_CLI_UNHANDLED",
        component: "cli.index",
        message: error instanceof Error ? error.message : "Unhandled CLI failure.",
      }),
    ],
  });
}

const argv = process.argv.slice(2);
const result = await dispatchCli({
  argv,
  cwd: process.cwd(),
  executablePath: fileURLToPath(import.meta.url),
}).catch((error: unknown) => internalResult(error));

const selectedOutput = outputMode(argv) === "json" ? renderJson(result) : renderHuman(result);
process.stdout.write(selectedOutput.endsWith("\n") ? selectedOutput : `${selectedOutput}\n`);
process.exitCode = exitCode(result);
