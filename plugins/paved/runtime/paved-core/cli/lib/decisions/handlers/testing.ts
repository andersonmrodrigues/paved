import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { resolveSafePath } from "../../safe-path.ts";
import { createRegistry } from "../../schemas.ts";
import type { AnswerValue } from "../answers.ts";
import type { DecisionContext, HandlerRegistration } from "../gate.ts";
import { detectTestingCandidates, TESTING_TOOL_PATH, testingOptionId } from "../providers/testing.ts";
import { CHECK_TIMEOUT_SECONDS, commandFor, slug } from "./verification.ts";

export const testingHandler: HandlerRegistration = { effect: "record-only", apply: () => [] };

const IMPLEMENTATION_PATH = ".paved/tool-implementations/testing.yaml";

function adopt(answer: AnswerValue, context: DecisionContext): readonly string[] {
  if (answer === "none") return [];
  const candidates = detectTestingCandidates(context.projectRoot);
  const chosen = answer === "all" && candidates.length > 1
    ? candidates
    : candidates.filter((item) => testingOptionId(item) === answer);
  if (chosen.length === 0) throw new Error(`Unknown testing option: ${String(answer)}.`);
  const documents = chosen.map((candidate) => {
    const { executable, args } = commandFor(candidate);
    const where = candidate.scope === "." ? "the repository root" : candidate.scope;
    const multi = chosen.length > 1;
    const name = slug(candidate);
    const tool = {
      apiVersion: "paved/v1", kind: "Tool", id: multi ? `project.testing-detected-${name}.run` : "project.testing.run", version: "0.1.0",
      title: `Run ${candidate.label} in ${where}`,
      purpose: `Run the repository-declared ${candidate.label} as the governed testing command.`,
      capability: "testing-run", safety: "safe-mutation",
      permissions: ["repository-read", "process-control"], environments: ["local"],
      inputs: [], outputs: { format: "text", description: "Process output and exit status." },
      side_effects: ["filesystem", "process"], preconditions: [], idempotency: "unknown",
      timeout_seconds: CHECK_TIMEOUT_SECONDS, retry: { max_attempts: 1, backoff_seconds: 0 },
      errors: ["execution-failure", "timeout", "implementation-unavailable"],
      evidence: { capture: ["revision", "environment", "timestamps", "output-digest"] },
      availability: "available", confirmation: "none",
    };
    const implementation = {
      apiVersion: "paved/v1", kind: "ToolImplementation", id: multi ? `project.testing-binding-${name}.run` : "project.testing-binding.run",
      tool: tool.id, version: "0.1.0", contract: "^0.1.0", source: "project",
      environments: ["local"],
      invocation: {
        type: "command", executable, arguments: args,
        working_directory: candidate.scope, timeout_seconds: CHECK_TIMEOUT_SECONDS,
      },
      availability: "available",
    };
    return {
      binding: { path: multi ? `.paved/tool-implementations/testing-${name}.yaml` : IMPLEMENTATION_PATH, document: implementation as unknown },
      tool: { path: multi ? `.paved/tools/testing-${name}.yaml` : TESTING_TOOL_PATH, document: tool as unknown },
    };
  });
  const files = [...documents.map((item) => item.binding), ...documents.map((item) => item.tool)];
  const registry = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]);
  for (const file of files) {
    const result = registry.validate(file.document);
    if (!result.valid) throw new Error(`${file.path} is invalid: ${result.errors.join("; ")}`);
    const path = resolveSafePath(context.projectRoot, file.path);
    if (existsSync(path) && JSON.stringify(parse(readFileSync(path, "utf8"))) !== JSON.stringify(file.document)) {
      throw new Error(`Refusing to overwrite an existing Paved document: ${file.path}`);
    }
  }
  // Bindings are written before Tools so a partial application cannot expose an unbound Tool.
  for (const file of files) {
    const path = resolveSafePath(context.projectRoot, file.path);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, stringify(file.document));
  }
  return files.map((file) => file.path);
}

export const testingAdoptHandler: HandlerRegistration = {
  effect: "config-additive", apply: adopt, reject: (answer) => answer === "none",
};
