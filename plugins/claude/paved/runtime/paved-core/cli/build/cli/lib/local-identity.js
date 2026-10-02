import { userInfo } from "node:os";
const RESERVED = ["agent", "paved", "ci"];
/** The local account name recorded for a human decision; never one of the names reserved for automation. */
export function localApprover() {
    try {
        const name = userInfo().username.trim();
        if (name && !RESERVED.includes(name.toLowerCase()))
            return name;
    }
    catch { /* no local account information */ }
    return "human";
}
