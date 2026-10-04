import { diagnose } from "./status.js";
export function doctorHandler(invocation) {
    return diagnose(invocation, "doctor");
}
