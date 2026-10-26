#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { renderHuman, renderJson } from "./output.js";
import { createDiagnostic, createResult, exitCode } from "./result.js";
import { dispatchCli } from "./runtime.js";
import { withPavedCommand } from "./lib/paved-command.js";
function outputMode(argv) {
    return argv.includes("--json") ? "json" : "human";
}
function internalResult(error) {
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
const dispatched = await dispatchCli({
    argv,
    cwd: process.cwd(),
    executablePath: fileURLToPath(import.meta.url),
}).catch((error) => internalResult(error));
const result = withPavedCommand(dispatched, process.env.PAVED_COMMAND);
const selectedOutput = outputMode(argv) === "json" ? renderJson(result) : renderHuman(result);
process.stdout.write(selectedOutput.endsWith("\n") ? selectedOutput : `${selectedOutput}\n`);
process.exitCode = exitCode(result);
