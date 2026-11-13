import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "../documents.js";
import { resolveSafePath } from "../safe-path.js";
import { createRegistry } from "../schemas.js";
import { runSourceRoot } from "../workflow-runs.js";
import { MEASUREMENT_STALE } from "../workflows.js";
import { blocked, fingerprint, now, projectRelative, reopenImplementation, sha, sharedPhase, sourceUnchanged } from "./shared.js";
/** Quantile with linear interpolation between closest ranks. */
function quantile(sorted, p) {
    const h = (sorted.length - 1) * p;
    const low = Math.floor(h);
    const high = Math.min(low + 1, sorted.length - 1);
    return sorted[low] + (h - low) * (sorted[high] - sorted[low]);
}
/**
 * Paved's own verdict on two sample sets. An improvement counts only when the after
 * interquartile range clears the baseline's entirely, so run-to-run noise in either set
 * cannot pass for a gain.
 */
export function compareSamples(baseline, after, direction) {
    const b = [...baseline].sort((x, y) => x - y);
    const a = [...after].sort((x, y) => x - y);
    const [bq1, bq3, aq1, aq3] = [quantile(b, 0.25), quantile(b, 0.75), quantile(a, 0.25), quantile(a, 0.75)];
    const better = direction === "lower-is-better" ? aq3 < bq1 : aq1 > bq3;
    const worse = direction === "lower-is-better" ? aq1 > bq3 : aq3 < bq1;
    const baselineMedian = quantile(b, 0.5);
    const afterMedian = quantile(a, 0.5);
    return {
        verdict: better ? "improved" : worse ? "regressed" : "within-noise",
        baselineMedian, afterMedian,
        ...(baselineMedian === 0 ? {} : { changePercent: ((afterMedian - baselineMedian) / Math.abs(baselineMedian)) * 100 }),
    };
}
const MEASUREMENT = "measurement=";
/** The measurement of a stage that Paved accepted, with the digests it was accepted under. */
function recorded(run, stage) {
    const event = run.events.findLast((item) => item.type === "evidence-recorded" && item.detail?.startsWith(`${MEASUREMENT}${stage};`));
    if (event?.ref === undefined)
        return undefined;
    const field = (name) => event.detail.split("; ").find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
    const digest = field("sha256");
    const source = field("source_sha256");
    return digest && source ? { ref: event.ref, sha256: digest, source } : undefined;
}
function readMeasurement(context, path, stage) {
    const refuse = (code, message, remediation) => ({ refused: blocked(code, message, remediation) });
    let document;
    try {
        document = loadYaml(path);
    }
    catch (error) {
        return refuse("PAVED_PERFORMANCE_MEASUREMENT_INVALID", `The measurement is not readable YAML: ${error instanceof Error ? error.message : String(error)}.`, "Fix the measurement record and advance again.");
    }
    const validation = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]).validate(document);
    const record = document;
    if (!validation.valid || record.kind !== "PerformanceMeasurement") {
        return refuse("PAVED_PERFORMANCE_MEASUREMENT_INVALID", `The ${stage} measurement is not a valid performance measurement record${validation.valid ? "" : `: ${validation.errors.join("; ")}`}.`, "Follow schemas/performance-measurement.schema.yaml: metric, method, at least three samples, limits, and for a baseline the hypothesis.");
    }
    if (record.stage !== stage || record.run !== context.run.id) {
        return refuse("PAVED_PERFORMANCE_MEASUREMENT_INVALID", `This phase needs the ${stage} measurement of run ${context.run.id}; the record is the ${record.stage} measurement of ${record.run}.`, `Record the ${stage} measurement with run: ${context.run.id} and stage: ${stage}.`);
    }
    return { record: record };
}
/** Both accepted measurements must still be the files Paved compared. */
function tampered(context) {
    for (const stage of ["baseline", "after"]) {
        const accepted = recorded(context.run, stage);
        if (accepted === undefined)
            continue;
        const path = resolveSafePath(context.projectRoot, accepted.ref);
        if (!existsSync(path) || sha(readFileSync(path)) !== accepted.sha256) {
            return blocked("PAVED_PERFORMANCE_MEASUREMENT_CHANGED", `The ${stage} measurement ${accepted.ref} changed or was removed after Paved accepted it.`, "Restore it. A measurement is never edited after the fact; measure again instead.");
        }
    }
    return undefined;
}
function accept(context, stage, path, extra = "") {
    const ref = projectRelative(context.projectRoot, path);
    context.run.events.push({ at: now(), type: "evidence-recorded", phase: context.phase.phase, ref,
        detail: `${MEASUREMENT}${stage}; sha256=${sha(readFileSync(path))}; source_sha256=${fingerprint(runSourceRoot(context.projectRoot, context.run))}${extra}` });
    return ref;
}
const format = (value) => String(Math.round(value * 1000) / 1000);
export const performanceGates = {
    workflow: "core.performance",
    handles: ["baseline-measured", "hypothesis-stated", "after-measured", "improvement-supported"],
    phases: {
        discovery: (context) => {
            if (!context.evidence) {
                return blocked("PAVED_PERFORMANCE_BASELINE_REQUIRED", "Discovery ends with a recorded baseline measurement.", `Measure before changing anything, write .paved/generated/measurements/${context.run.id}-baseline.yaml and advance with --evidence <record> --note <hypothesis>.`);
            }
            if (!sourceUnchanged(context.projectRoot, context.run)) {
                return blocked("PAVED_PERFORMANCE_BASELINE_LATE", "A source or test file changed since the run started, so this is not a baseline of the code before the change.", "Restore the code as it was when the run started, measure the baseline there and advance again.");
            }
            const baseline = readMeasurement(context, context.evidence, "baseline");
            if ("refused" in baseline)
                return baseline.refused;
            accept(context, "baseline", context.evidence);
            context.phase.gates = [{ id: "baseline-measured", status: "passed" }, { id: "hypothesis-stated", status: "passed" }];
            return { kind: "pass" };
        },
        implementation: (context) => {
            const { run, projectRoot } = context;
            const accepted = recorded(run, "baseline");
            if (accepted === undefined)
                return blocked("PAVED_PERFORMANCE_BASELINE_REQUIRED", "No baseline measurement was accepted in discovery.", "A performance run needs its baseline first; start a new run.");
            const changed = tampered(context);
            if (changed)
                return changed;
            if (!context.evidence) {
                return blocked("PAVED_PERFORMANCE_AFTER_REQUIRED", "Implementation ends with the after measurement.", `Measure the changed code with the baseline's method, write .paved/generated/measurements/${run.id}-after.yaml and advance with --evidence <record> --note <what changed>.`);
            }
            const baselineRead = readMeasurement(context, resolveSafePath(projectRoot, accepted.ref), "baseline");
            if ("refused" in baselineRead)
                return baselineRead.refused;
            const afterRead = readMeasurement(context, context.evidence, "after");
            if ("refused" in afterRead)
                return afterRead.refused;
            const { record: baseline } = baselineRead;
            const { record: after } = afterRead;
            if (JSON.stringify(after.metric) !== JSON.stringify(baseline.metric) || JSON.stringify(after.method) !== JSON.stringify(baseline.method)) {
                return blocked("PAVED_PERFORMANCE_METHOD_CHANGED", "The after measurement does not repeat the baseline's metric and method, so the two cannot be compared.", "Measure again with exactly the baseline's metric, command, workload, environment and warm-up.");
            }
            const comparison = compareSamples(baseline.samples, after.samples, baseline.metric.direction);
            const summary = `${baseline.metric.name}: median ${format(comparison.baselineMedian)} → ${format(comparison.afterMedian)} ${baseline.metric.unit}`
                + (comparison.changePercent === undefined ? "" : ` (${comparison.changePercent > 0 ? "+" : ""}${format(comparison.changePercent)}%)`);
            context.phase.gates = [{ id: "after-measured", status: "passed" }];
            if (comparison.verdict !== "improved") {
                return {
                    kind: "fail",
                    reason: `The after measurement is ${comparison.verdict === "regressed" ? "worse than" : "within the noise of"} the baseline: ${summary}.`,
                    nextAction: "Do not claim an improvement. Reduce noise or add repetitions and measure again with the same method, try the next hypothesis by amending the plan, or abandon the run.",
                    diagnostics: [],
                };
            }
            accept(context, "after", context.evidence, `; verdict=improved; ${summary}`);
            context.phase.gates.push({ id: "improvement-supported", status: "passed" });
            return { kind: "pass" };
        },
        // Builds on the shared verification: the checks must run on exactly the code that was measured.
        verification: async (context) => {
            const changed = tampered(context);
            if (changed)
                return changed;
            const after = recorded(context.run, "after");
            if (after !== undefined && after.source !== fingerprint(runSourceRoot(context.projectRoot, context.run))) {
                reopenImplementation(context.run, MEASUREMENT_STALE);
                return { kind: "wait", nextAction: `The source changed after the after measurement, so implementation is open again. Measure the current code with the baseline's method and run paved execute --run ${context.run.id} --auto --evidence <after measurement> --note <what changed> --json.` };
            }
            return sharedPhase("verification")(context);
        },
    },
};
