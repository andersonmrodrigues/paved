import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolveSafePath } from "../safe-path.js";
import { runSourceRoot } from "../workflow-runs.js";
import { blocked, fingerprint, now, projectRelative, sha, sourceUnchanged, VERIFIED_SOURCE } from "./shared.js";
const SECTIONS = ["Answer", "Claims", "Recommendation"];
const LABELED = /^\[(observed|inferred|unknown)\]\s*(.*)$/s;
// A path needs a separator or an extension, so `host:8080` is not taken for a file.
const LINE_CITATION = /^([^\s:$][^\s:]*[/.][^\s:]*):(\d+)(?:-(\d+))?$/;
const COMMIT_CITATION = /^commit ([0-9a-f]{7,40})$/;
const COMMAND_CITATION = /^\$ \S/;
function sections(text) {
    const found = new Map();
    let current;
    let fenced = false;
    for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("```"))
            fenced = !fenced;
        const heading = fenced ? undefined : /^##\s+(.+?)\s*$/.exec(line);
        if (heading) {
            current = [];
            found.set(heading[1], current);
        }
        else {
            current?.push(line);
        }
    }
    return found;
}
/** Top-level list items of a section, with their indented continuation lines joined. */
function listItems(lines) {
    const items = [];
    for (const line of lines) {
        const item = /^[-*]\s+(.*)$/.exec(line);
        if (item)
            items.push(item[1]);
        else if (/^\s+\S/.test(line) && items.length > 0)
            items[items.length - 1] += ` ${line.trim()}`;
    }
    return items;
}
const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
/** A citation span this checker understands, or undefined for ordinary inline code. */
function citationKind(span) {
    if (COMMIT_CITATION.test(span))
        return "commit";
    if (COMMAND_CITATION.test(span))
        return "command";
    if (LINE_CITATION.test(span))
        return "line";
    return undefined;
}
function lineProblem(sourceRoot, span) {
    const [, path, first, last] = LINE_CITATION.exec(span);
    const start = Number(first);
    const end = last === undefined ? start : Number(last);
    let file;
    try {
        file = resolveSafePath(sourceRoot, path);
    }
    catch {
        return `\`${span}\` points outside the repository`;
    }
    if (!existsSync(file) || !statSync(file).isFile())
        return `\`${span}\` names a file that does not exist`;
    const lines = readFileSync(file, "utf8").split("\n").length;
    if (start < 1 || end < start || end > lines)
        return `\`${span}\` is outside the file's ${lines} lines`;
    return undefined;
}
function commitProblem(sourceRoot, span) {
    const [, id] = COMMIT_CITATION.exec(span);
    const found = spawnSync("git", ["cat-file", "-e", `${id}^{commit}`], { cwd: sourceRoot, encoding: "utf8", shell: false });
    return found.status === 0 ? undefined : `\`${span}\` does not resolve to a commit in this repository`;
}
/**
 * Problems with an investigation answer read against the checkout it cites. Line and
 * commit citations must resolve; a `$ command` citation is recorded as stated.
 */
export function assessAnswer(sourceRoot, text) {
    const problems = [];
    const found = sections(text);
    for (const name of SECTIONS) {
        const body = found.get(name);
        if (body === undefined)
            problems.push(`the answer has no "## ${name}" section`);
        else if (body.join("").trim() === "")
            problems.push(`the "## ${name}" section is empty`);
    }
    const claims = [];
    listItems(found.get("Claims") ?? []).forEach((item, index) => {
        const at = `claim ${index + 1}`;
        const labeled = LABELED.exec(item);
        if (!labeled) {
            problems.push(`${at} does not start with [observed], [inferred] or [unknown]`);
            return;
        }
        const label = labeled[1];
        const statement = labeled[2].trim();
        const citations = codeSpans(statement).filter((span) => citationKind(span) !== undefined);
        if (statement.replace(/`[^`]*`/g, "").trim() === "")
            problems.push(`${at} states nothing besides its sources`);
        if (label !== "unknown" && citations.length === 0)
            problems.push(`${at} is ${label} but cites no file and line, commit or command`);
        for (const span of citations) {
            const kind = citationKind(span);
            const problem = kind === "line" ? lineProblem(sourceRoot, span) : kind === "commit" ? commitProblem(sourceRoot, span) : undefined;
            if (problem)
                problems.push(`${at}: ${problem}`);
        }
        claims.push({ label, text: statement, citations });
    });
    if (found.has("Claims") && claims.length === 0 && !problems.some((problem) => problem.startsWith("claim"))) {
        problems.push('the "## Claims" section lists no claim');
    }
    return { problems, claims };
}
const answerRef = (run) => run.events.findLast((event) => event.type === "evidence-recorded" && event.phase === "discovery" && event.ref !== undefined)?.ref;
const sourceChanged = (run) => blocked("PAVED_INVESTIGATION_SOURCE_CHANGED", "A source or test file changed during a read-only investigation.", "Restore the files the investigation changed and advance again. An investigation never changes code: put the change in the answer's recommendation "
    + `and start it as a feature, bug, refactor or performance run with paved intent once this run (${run.id}) completes.`);
function checkAnswer(context, path) {
    const source = runSourceRoot(context.projectRoot, context.run);
    if (!path.endsWith(".md")) {
        return blocked("PAVED_INVESTIGATION_ANSWER_INVALID", "The investigation answer must be a Markdown document.", `Write the answer at .paved/documents/research/${context.run.id}.md and advance with --evidence <answer>.`);
    }
    const { problems } = assessAnswer(source, readFileSync(path, "utf8"));
    if (problems.length === 0)
        return undefined;
    return blocked("PAVED_INVESTIGATION_ANSWER_INVALID", `The answer is not fully cited: ${problems.join("; ")}.`, "Label every claim [observed], [inferred] or [unknown], give each observed or inferred claim a `path:line`, `commit <sha>` or `$ command` source, and advance again.");
}
export const investigationGates = {
    workflow: "core.investigation",
    handles: ["question-clear", "answer-cited", "read-only"],
    sharedGates: ["criteria-met"],
    phases: {
        context: (context) => {
            context.phase.gates = [{ id: "question-clear", status: "passed" }];
            return { kind: "pass" };
        },
        discovery: (context) => {
            if (!sourceUnchanged(context.projectRoot, context.run))
                return sourceChanged(context.run);
            if (!context.evidence) {
                return blocked("PAVED_INVESTIGATION_ANSWER_REQUIRED", "Discovery ends with the cited answer.", `Write the answer at .paved/documents/research/${context.run.id}.md, then advance with --evidence <answer> --note <one-line answer>.`);
            }
            const invalid = checkAnswer(context, context.evidence);
            if (invalid)
                return invalid;
            context.phase.gates = [{ id: "answer-cited", status: "passed" }];
            return { kind: "pass", ref: projectRelative(context.projectRoot, context.evidence) };
        },
        // Replaces the shared verification: nothing changed, so there is nothing for the project's checks to prove.
        verification: (context) => {
            const { run, projectRoot } = context;
            const ref = answerRef(run);
            if (ref === undefined)
                return blocked("PAVED_INVESTIGATION_ANSWER_REQUIRED", "No answer was recorded in discovery.", "Complete discovery with --evidence <answer>.");
            if (!sourceUnchanged(projectRoot, run))
                return sourceChanged(run);
            const path = resolveSafePath(projectRoot, ref);
            if (!existsSync(path))
                return blocked("PAVED_INVESTIGATION_ANSWER_REQUIRED", `The answer ${ref} was removed.`, "Restore the answer and advance again.");
            const invalid = checkAnswer(context, path);
            if (invalid)
                return invalid;
            context.phase.gates = [{ id: "read-only", status: "passed" }];
            run.events.push({ at: now(), type: "verification-executed", phase: "verification", ref,
                detail: `${VERIFIED_SOURCE}${fingerprint(runSourceRoot(projectRoot, run))}` });
            return { kind: "pass" };
        },
        evidence: (context) => {
            const { run, projectRoot } = context;
            const ref = answerRef(run);
            if (ref === undefined)
                return blocked("PAVED_INVESTIGATION_ANSWER_REQUIRED", "No answer was recorded in discovery.", "Complete discovery with --evidence <answer>.");
            run.evidence = ref;
            run.events.push({ at: now(), type: "evidence-recorded", phase: "evidence", ref, detail: `sha256=${sha(readFileSync(resolveSafePath(projectRoot, ref)))}` });
            return { kind: "pass" };
        },
    },
};
