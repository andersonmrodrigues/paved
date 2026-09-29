import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectConsumer } from "../../consumer-state.ts";
import type { DecisionProvider } from "../gate.ts";

const REPAIRABLE = new Set([
  "PAVED_GENERATED_SOURCE_STALE", "PAVED_GENERATOR_INPUTS_STALE", "PAVED_GENERATED_OUTPUT_MISSING",
]);

export const repairProvider: DecisionProvider = (context) => {
  const findings = inspectConsumer({ projectRoot: context.projectRoot, coreRoot: context.coreRoot }).diagnostics
    .filter((item) => REPAIRABLE.has(item.code));
  if (findings.length === 0) return [];
  const evidencePath = ".paved/generated/state/last-run.json";
  const evidenceFile = join(context.projectRoot, evidencePath);
  if (!existsSync(evidenceFile)) return [];
  const evidence = [{
    type: "file" as const, location: evidencePath,
    sha256: createHash("sha256").update(readFileSync(evidenceFile)).digest("hex"),
  }];
  const candidates = findings.map((item) => `${item.code}:${item.message}`).sort((a, b) => a.localeCompare(b, "en"));
  return [{
    scope: "project",
    question: "Should Paved regenerate the affected project context files?",
    reason: `Doctor found: ${findings.map((item) => item.message).join(" ")} Applying this repair reruns project context generators and can change generated files.`,
    options: [
      { id: "apply", label: "Regenerate affected context", description: "Run the project context generators again.", consequence: "Generated context files and generator state may change." },
      { id: "skip", label: "Skip", description: "Leave generated files unchanged.", consequence: "The reported findings remain until handled later." },
    ],
    recommended: "apply", evidence, required: false,
    requiredAnswer: { type: "single-choice" }, effect: "repository-mutating",
    handler: "repair.apply", candidates,
  }];
};
