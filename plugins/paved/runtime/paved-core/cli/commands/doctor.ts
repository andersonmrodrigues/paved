import type { CommandResult } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { diagnose } from "./status.ts";

export function doctorHandler(invocation: CommandInvocation): CommandResult {
  return diagnose(invocation, "doctor");
}
