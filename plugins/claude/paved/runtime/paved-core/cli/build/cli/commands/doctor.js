import { createResult } from "../result.js";
import { diagnose } from "./status.js";
import { diagnoseQuick } from "../lib/doctor-quick.js";
export function doctorHandler(invocation) {
    if (invocation.flags.quick) {
        const data = diagnoseQuick({
            projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
            ...(invocation.launcherCoreVersion === undefined ? {} : { launcherCoreVersion: invocation.launcherCoreVersion }),
        });
        return createResult({ command: "doctor", status: data.status === "healthy" ? "success" : "warning", data });
    }
    return diagnose(invocation, "doctor");
}
