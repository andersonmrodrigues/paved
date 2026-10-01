import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { planMavenDependencies } from "../../../../adapters/technology/java/maven-dependencies.js";
import { discoverSources } from "../../generator-runtime.js";
// Only lifecycle phases that every Maven build defines. Nothing is inferred from a
// script the repository did not declare.
const MAVEN_CHECKS = [
    { id: "mvn-validate", label: "mvn validate", command: "validate" },
    { id: "mvn-test", label: "mvn test", command: "test" },
];
const NPM_CHECKS = [
    { id: "npm-build", label: "npm run build", script: "build" },
    { id: "npm-test", label: "npm test", script: "test" },
];
const scopeOf = (path) => (path.includes("/") ? dirname(path) : ".");
const NG_TEST = /^\s*ng\s+test\b/;
/** `ng test` compiles only `*.spec.ts`; with none it fails with "No inputs were found". */
function hasAngularSpecs(paths, scope) {
    return paths.some((path) => (scope === "." || path.startsWith(`${scope}/`)) && path.endsWith(".spec.ts"));
}
/**
 * `ng test` watches for changes by default, so it never exits on its own. A Karma builder
 * also opens a real browser; headless Chrome is the launcher Angular's Karma setup ships.
 */
function angularTestArgs(projectRoot, scope, script) {
    if (!NG_TEST.test(script))
        return undefined;
    if (/--watch(=|\s|$)|--no-watch/.test(script))
        return undefined;
    let karma = false;
    try {
        karma = /"builder"\s*:\s*"[^"]*:karma"/.test(readFileSync(join(projectRoot, scope, "angular.json"), "utf8"));
    }
    catch { /* no angular.json: only the watch flag applies */ }
    return karma && !/--browsers/.test(script) ? ["--watch=false", "--browsers=ChromeHeadless"] : ["--watch=false"];
}
export function scopeOptionId(scope) {
    if (scope === ".")
        return "scope-root";
    const prefix = scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        .slice(0, 40).replace(/-$/, "");
    const digest = createHash("sha256").update(scope).digest("hex").slice(0, 8);
    return `scope-${prefix}-${digest}`;
}
export function detectCheckCandidates(projectRoot) {
    const candidates = [];
    const sources = discoverSources(projectRoot);
    const paths = sources.map((source) => source.path);
    const mavenScopes = sources.filter((source) => basename(source.path) === "pom.xml").map((source) => scopeOf(source.path));
    const mavenPlan = planMavenDependencies(projectRoot, mavenScopes);
    const mavenRank = new Map(mavenPlan.scopes.map((scope, index) => [scope, index]));
    for (const source of sources) {
        const evidence = { type: "file", location: source.path, sha256: source.sha256 };
        const scope = scopeOf(source.path);
        if (basename(source.path) === "pom.xml") {
            for (const check of MAVEN_CHECKS) {
                candidates.push(check.id === "mvn-test" && mavenPlan.installs.has(scope)
                    ? { ...check, label: "mvn install", command: "install", scope, source: evidence }
                    : { ...check, scope, source: evidence });
            }
        }
        if (basename(source.path) === "package.json") {
            let scripts = {};
            try {
                scripts = JSON.parse(readFileSync(join(projectRoot, source.path), "utf8")).scripts ?? {};
            }
            catch {
                continue;
            }
            for (const check of NPM_CHECKS) {
                const script = scripts[check.script];
                if (typeof script !== "string" || script.trim() === "")
                    continue;
                // A test script that cannot find a single test cannot pass, so it is not offered as a gate.
                if (check.id === "npm-test" && NG_TEST.test(script) && !hasAngularSpecs(paths, scope))
                    continue;
                const scriptArgs = check.id === "npm-test" ? angularTestArgs(projectRoot, scope, script) : undefined;
                candidates.push({
                    id: check.id, label: check.label, command: check.script, scope, source: evidence,
                    ...(scriptArgs === undefined ? {} : { scriptArgs }),
                });
            }
        }
    }
    return candidates
        .map((candidate) => ({ ...candidate, source: { type: "file", location: candidate.source.location, sha256: candidate.source.sha256 } }))
        .sort((a, b) => {
        const aRank = a.id.startsWith("mvn-") ? mavenRank.get(a.scope) : undefined;
        const bRank = b.id.startsWith("mvn-") ? mavenRank.get(b.scope) : undefined;
        if (aRank !== undefined && bRank !== undefined)
            return aRank - bRank || a.id.localeCompare(b.id, "en");
        if (aRank !== undefined)
            return -1;
        if (bRank !== undefined)
            return 1;
        return `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`, "en");
    });
}
/**
 * Raises nothing when a profile already exists: valid existing configuration is read as
 * already decided, and Paved does not re-ask an answered question (spec 3.4).
 */
export const verificationProvider = (context) => {
    if (existsSync(join(context.projectRoot, ".paved/verification/profile.yaml")))
        return [];
    const candidates = detectCheckCandidates(context.projectRoot);
    if (candidates.length === 0)
        return [];
    const scopes = [...new Set(candidates.map((item) => item.scope))].sort((a, b) => a.localeCompare(b, "en"));
    const options = [
        {
            id: "all", label: "All detected checks",
            description: candidates.map((item) => item.label).join(", "),
            consequence: "Every detected check becomes a Paved verification gate.",
        },
        ...scopes.map((scope) => ({
            id: scopeOptionId(scope),
            label: scope === "." ? "Repository root only" : `${scope} only`,
            description: candidates.filter((item) => item.scope === scope).map((item) => item.label).join(", "),
            consequence: `Only the checks detected in ${scope === "." ? "the repository root" : scope} become gates.`,
        })),
        {
            id: "none", label: "None",
            description: "Adopt no checks now.",
            consequence: "No verification profile is created and verification stays unavailable.",
        },
    ];
    const evidence = [...new Map(candidates.map((item) => [item.source.location, item.source])).values()]
        .sort((a, b) => a.location.localeCompare(b.location, "en"));
    return [{
            scope: "project",
            question: "Should the detected repository checks become Paved verification gates?",
            reason: "These commands already exist in the repository, but Paved authorizes no check implicitly. "
                + "Adopting them lets verification prove a change before it completes.",
            options,
            recommended: "all",
            evidence,
            required: true,
            requiredAnswer: { type: "single-choice" },
            effect: "config-additive",
            handler: "verification.adopt",
            candidates: candidates.map((item) => `${item.scope}:${item.id}`),
        }];
};
