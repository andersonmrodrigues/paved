import { globRegex } from "./adapters.js";
// Extra patterns supplement these defaults rather than disabling them.
const sensitivePatterns = [
    "auth", "migration", "permission", "money", "payment", "billing", "invoice",
    "personal", "pii", "user", "customer", "profile", "email",
].flatMap((area) => [`**/*${area}*`, `**/*${area}*/**`]);
export function planReview(files, options = {}) {
    const patterns = [...sensitivePatterns, ...(options.sensitivePatterns ?? [])]
        .map((pattern) => ({ pattern, regex: globRegex(pattern.toLowerCase()) }));
    const sensitiveMatches = [];
    const unknownCountPaths = [];
    let total = 0;
    for (const file of files) {
        const path = file.path.replaceAll("\\", "/").toLowerCase();
        for (const { pattern, regex } of patterns) {
            if (regex.test(path))
                sensitiveMatches.push({ path: file.path, pattern });
        }
        if (file.added === null || file.deleted === null)
            unknownCountPaths.push(file.path);
        for (const count of [file.added, file.deleted]) {
            if (count === null)
                continue;
            if (!Number.isSafeInteger(count) || count < 0)
                throw new RangeError("Line counts must be nonnegative safe integers.");
            total += count;
            if (!Number.isSafeInteger(total))
                throw new RangeError("Total line count must be a safe integer.");
        }
    }
    const threshold = unknownCountPaths.length > 0 ? "unknown"
        : total < 50 ? "under-50"
            : total <= 300 ? "50-to-300"
                : "over-300";
    const lenses = threshold === "unknown" || threshold === "over-300" || sensitiveMatches.length > 0
        ? ["Skeptic", "Architect", "Minimalist"]
        : threshold === "50-to-300" ? ["Skeptic"] : [];
    return {
        reviewers: lenses.map((lens) => ({ role: "independent reviewer", lens })),
        evidence: {
            changedLines: unknownCountPaths.length > 0 ? null : total,
            threshold,
            sensitiveMatches,
            unknownCountPaths,
        },
    };
}
