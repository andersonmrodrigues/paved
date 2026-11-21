export const REVIEW_LENSES = ["Skeptic", "Architect", "Minimalist", "Security", "ThreatModel", "Performance"];
export function reviewBundleProblem(reviews, requiredLenses) {
    const identities = reviews.map((entry) => entry.reviewer.agent.trim().toLocaleLowerCase("en"));
    if (new Set(identities).size !== identities.length) {
        return {
            code: "PAVED_REVIEW_DUPLICATE_REVIEWER",
            message: "Every required review lens must have a different reviewer identity.",
        };
    }
    const lenses = reviews.map((entry) => entry.reviewer.lens);
    if (new Set(lenses).size !== lenses.length || requiredLenses.some((lens) => !lenses.includes(lens))
        || lenses.some((lens) => !requiredLenses.includes(lens))) {
        return {
            code: "PAVED_REVIEW_LENSES_INCOMPLETE",
            message: `Review evidence must cover exactly these independent lenses: ${requiredLenses.join(", ") || "none"}.`,
        };
    }
    const nonIsolated = reviews.filter((entry) => !entry.reviewer.isolated);
    if (nonIsolated.length > 0) {
        return {
            code: "PAVED_REVIEW_NOT_INDEPENDENT",
            message: `The ${nonIsolated.map((entry) => entry.reviewer.lens).join(", ")} review was not made in an isolated context.`,
        };
    }
    return undefined;
}
