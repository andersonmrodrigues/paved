import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { discoverSources } from "../../generator-runtime.ts";
import type { DecisionCandidate, DecisionProvider } from "../gate.ts";
import type { DecisionEvidence } from "../record.ts";

export interface CheckCandidate {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly scope: string;
  readonly source: DecisionEvidence;
}

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

const scopeOf = (path: string) => (path.includes("/") ? dirname(path) : ".");

export function detectCheckCandidates(projectRoot: string): CheckCandidate[] {
  const candidates: CheckCandidate[] = [];
  for (const source of discoverSources(projectRoot)) {
    const evidence: DecisionEvidence = { type: "file", location: source.path, sha256: source.sha256 };
    const scope = scopeOf(source.path);

    if (basename(source.path) === "pom.xml") {
      for (const check of MAVEN_CHECKS) {
        candidates.push({ ...check, scope, source: evidence });
      }
    }

    if (basename(source.path) === "package.json") {
      let scripts: Record<string, unknown> = {};
      try {
        scripts = (JSON.parse(readFileSync(join(projectRoot, source.path), "utf8")) as {
          scripts?: Record<string, unknown>;
        }).scripts ?? {};
      } catch { continue; }
      for (const check of NPM_CHECKS) {
        const script = scripts[check.script];
        if (typeof script !== "string" || script.trim() === "") continue;
        candidates.push({
          id: check.id, label: check.label, command: check.script, scope, source: evidence,
        });
      }
    }
  }
  return candidates
    .map((candidate) => ({ ...candidate, source: { type: "file" as const, location: candidate.source.location, sha256: candidate.source.sha256 } }))
    .sort((a, b) => `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`, "en"));
}

/**
 * Raises nothing when a profile already exists: valid existing configuration is read as
 * already decided, and Paved does not re-ask an answered question (spec 3.4).
 */
export const verificationProvider: DecisionProvider = (context): readonly DecisionCandidate[] => {
  if (existsSync(join(context.projectRoot, ".paved/verification/profile.yaml"))) return [];
  const candidates = detectCheckCandidates(context.projectRoot);
  if (candidates.length === 0) return [];

  const scopes = [...new Set(candidates.map((item) => item.scope))].sort((a, b) => a.localeCompare(b, "en"));
  const options = [
    {
      id: "all", label: "All detected checks",
      description: candidates.map((item) => item.label).join(", "),
      consequence: "Every detected check becomes a Paved verification gate.",
    },
    ...scopes.map((scope) => ({
      id: `scope-${scope === "." ? "root" : scope.replace(/\//g, "-")}`,
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
    reason:
      "These commands already exist in the repository, but Paved authorizes no check implicitly. "
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
