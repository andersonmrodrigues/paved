import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { resolveSafePath } from "../../safe-path.ts";
import { createRegistry } from "../../schemas.ts";
import type { AnswerValue } from "../answers.ts";
import type { DecisionContext, HandlerRegistration } from "../gate.ts";
import { detectCheckCandidates, scopeOptionId, type CheckCandidate } from "../providers/verification.ts";

const PROFILE_PATH = ".paved/verification/profile.yaml";

function selected(answer: AnswerValue, candidates: readonly CheckCandidate[]): CheckCandidate[] {
  if (answer === "none") return [];
  if (answer === "all") return [...candidates];
  if (typeof answer === "string" && answer.startsWith("scope-")) {
    return candidates.filter((item) => scopeOptionId(item.scope) === answer);
  }
  throw new Error(`Unknown verification option: ${String(answer)}.`);
}

function slug(candidate: CheckCandidate): string {
  const key = `${candidate.scope}:${candidate.id}`;
  const prefix = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

function documents(candidate: CheckCandidate) {
  const name = slug(candidate);
  const checkId = `project.detected.${name}`;
  const toolId = `project.verification.${name}`;
  const implementationId = `project.verification-binding.${name}`;
  const isMaven = candidate.id.startsWith("mvn-");
  const executable = isMaven ? "mvn" : "npm";
  const args = isMaven ? [candidate.command] : ["run", candidate.command];
  const tool = {
    apiVersion: "paved/v1", kind: "Tool", id: toolId, version: "0.1.0",
    title: `Run ${candidate.label}`, purpose: `Execute the repository-declared ${candidate.label} check.`,
    capability: "verification-run", safety: "safe-mutation",
    permissions: ["repository-read", "process-control"], environments: ["local"],
    inputs: [], outputs: { format: "text", description: "Process output and exit status." },
    side_effects: ["filesystem", "process"], preconditions: [], idempotency: "unknown",
    timeout_seconds: 300, retry: { max_attempts: 1, backoff_seconds: 0 },
    errors: ["execution-failure", "timeout", "implementation-unavailable"],
    evidence: { capture: ["revision", "environment", "timestamps", "output-digest"] },
    availability: "available", confirmation: "none",
  };
  const implementation = {
    apiVersion: "paved/v1", kind: "ToolImplementation", id: implementationId,
    tool: toolId, version: "0.1.0", contract: "^0.1.0", source: "project",
    environments: ["local"],
    invocation: {
      type: "command", executable, arguments: args,
      working_directory: candidate.scope, timeout_seconds: 300,
    },
    availability: "available",
  };
  const check = {
    apiVersion: "paved/v1", kind: "Check", id: checkId,
    title: `${candidate.label} passes`, purpose: `Confirm ${candidate.label} succeeds in ${candidate.scope}.`,
    type: candidate.id.endsWith("-test") ? "unit" : "build", tool: toolId,
    expected: { description: "The command exits successfully.", exit_code: 0 },
    failure: `The ${candidate.label} command failed; inspect its captured output.`,
    determinism: {
      class: "controlled", sources: ["environment-drift"],
      controls: "Run against the recorded repository revision and capture the local environment.",
    },
  };
  return { name, checkId, check, tool, implementation };
}

/** Writes the complete runnable contract set, with the profile last as its commit marker. */
function apply(answer: AnswerValue, context: DecisionContext): readonly string[] {
  const candidates = detectCheckCandidates(context.projectRoot);
  const chosen = selected(answer, candidates);
  if (answer !== "none" && chosen.length === 0) {
    throw new Error("The selected verification checks are no longer present in the repository.");
  }
  if (chosen.length === 0) return [];

  const registry = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]);
  const files: { path: string; document: unknown }[] = chosen.flatMap((candidate) => {
    const item = documents(candidate);
    return [
      { path: `.paved/verification/checks/${item.name}.yaml`, document: item.check },
      { path: `.paved/tools/${item.name}.yaml`, document: item.tool },
      { path: `.paved/tool-implementations/${item.name}.yaml`, document: item.implementation },
    ];
  });
  const profile = {
    apiVersion: "paved/v1", kind: "VerificationProfile",
    checks: chosen.map((candidate) => documents(candidate).checkId),
  };
  files.push({ path: PROFILE_PATH, document: profile });

  for (const file of files) {
    const result = registry.validate(file.document);
    if (!result.valid) throw new Error(`${file.path} is invalid: ${result.errors.join("; ")}`);
    const path = resolveSafePath(context.projectRoot, file.path);
    if (existsSync(path) && JSON.stringify(parse(readFileSync(path, "utf8"))) !== JSON.stringify(file.document)) {
      throw new Error(`Refusing to overwrite an existing Paved document: ${file.path}`);
    }
  }
  for (const file of files) {
    const path = resolveSafePath(context.projectRoot, file.path);
    mkdirSync(join(path, ".."), { recursive: true });
    atomicWriteFileSync(path, stringify(file.document));
  }
  return files.map((file) => file.path);
}

export const verificationHandler: HandlerRegistration = {
  effect: "config-additive", apply, reject: (answer) => answer === "none",
};
