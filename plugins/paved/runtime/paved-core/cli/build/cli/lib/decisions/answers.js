export class AnswerIdentityError extends Error {
}
const DECISION_ID = /^d-[a-f0-9]{20}$/;
const RESERVED_IDENTITIES = new Set(["agent", "paved", "ci"]);
/**
 * Parses repeatable `--answer <decision-id>=<value>` pairs. Values are never split on
 * commas: a multi-choice answer repeats the flag, because commas are legal inside a
 * free-text answer (spec 5.3).
 */
export function parseAnswerFlags(raw) {
    const byDecision = new Map();
    const problems = [];
    for (const entry of raw) {
        const separator = entry.indexOf("=");
        if (separator <= 0) {
            problems.push(`Malformed --answer value: ${entry}. Use <decision-id>=<value>.`);
            continue;
        }
        const id = entry.slice(0, separator);
        const value = entry.slice(separator + 1);
        if (!DECISION_ID.test(id)) {
            problems.push(`Malformed decision id in --answer: ${id}.`);
            continue;
        }
        byDecision.set(id, [...(byDecision.get(id) ?? []), value]);
    }
    return problems.length > 0 ? { problems } : { byDecision };
}
export function validateAnswer(decision, values) {
    const known = new Set(decision.options.map((option) => option.id));
    const type = decision.required_answer.type;
    if (values.length === 0)
        return { problems: [`Decision ${decision.id} received no answer value.`] };
    if (type === "single-choice") {
        if (values.length !== 1)
            return { problems: [`Decision ${decision.id} accepts exactly one option.`] };
        const value = values[0];
        if (!known.has(value))
            return { problems: [`Unknown option for ${decision.id}: ${value}.`] };
        return { value };
    }
    if (type === "multi-choice") {
        if (new Set(values).size !== values.length) {
            return { problems: [`Decision ${decision.id} received a duplicated option.`] };
        }
        const unknown = values.filter((value) => !known.has(value));
        if (unknown.length > 0)
            return { problems: [`Unknown option(s) for ${decision.id}: ${unknown.join(", ")}.`] };
        return { value: [...values].sort((a, b) => a.localeCompare(b, "en")) };
    }
    if (type === "boolean") {
        if (values.length !== 1)
            return { problems: [`Decision ${decision.id} accepts exactly one value.`] };
        const value = values[0];
        if (value !== "true" && value !== "false") {
            return { problems: [`Decision ${decision.id} expects true or false, received ${value}.`] };
        }
        return { value: value === "true" };
    }
    if (values.length !== 1)
        return { problems: [`Decision ${decision.id} accepts exactly one value.`] };
    const value = values[0];
    const limit = decision.required_answer.max_length ?? 500;
    if (value.length > limit)
        return { problems: [`Answer for ${decision.id} exceeds ${limit} characters.`] };
    const pattern = decision.required_answer.pattern;
    if (pattern !== undefined && !new RegExp(pattern).test(value)) {
        return { problems: [`Answer for ${decision.id} does not match the required pattern.`] };
    }
    return { value };
}
/**
 * There is deliberately no fallback to `git config user.email`: a fallback would hand
 * an agent a plausible human identity for free, which is the forgery the approval model
 * exists to prevent (spec 5.3).
 */
export function assertAnswerIdentity(identity) {
    const trimmed = identity?.trim();
    if (trimmed === undefined || trimmed === "") {
        throw new AnswerIdentityError("--answered-by is required whenever --answer is supplied.");
    }
    if (RESERVED_IDENTITIES.has(trimmed)) {
        throw new AnswerIdentityError(`--answered-by must name a person, not ${trimmed}.`);
    }
    return trimmed;
}
