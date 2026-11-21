import { createResult, type CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { diagnose } from "./status.ts";
import { diagnoseQuick } from "../lib/doctor-quick.ts";

export function doctorHandler(invocation: CommandInvocation): CommandResult {
  if (invocation.flags.quick) {
    const data = diagnoseQuick({
      projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
      ...(invocation.launcherCoreVersion === undefined ? {} : { launcherCoreVersion: invocation.launcherCoreVersion }),
    });
    return createResult({ command: "doctor", status: data.status === "healthy" ? "success" : "warning", data });
  }
  return diagnose(invocation, "doctor");
}
