import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTestingTool } from "../../test-runner.ts";
import type { DecisionProvider } from "../gate.ts";

function optionId(id: string): string {
  const slug = id.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

export const testingProvider: DecisionProvider = (context) => {
  const resolution = resolveTestingTool(context.projectRoot, context.coreRoot);
  if (resolution.status !== "ambiguous") return [];
  const manifest = join(context.projectRoot, ".paved/manifest.yaml");
  if (!existsSync(manifest)) return [];
  const evidence = [{
    type: "file" as const,
    location: ".paved/manifest.yaml",
    sha256: createHash("sha256").update(readFileSync(manifest)).digest("hex"),
  }];
  return [{
    scope: "project",
    question: "Which authorized testing Tool should run for this project?",
    reason: "Several declared testing Tools have authorized implementations; the project must select one.",
    options: resolution.candidates.map((id) => ({
      id: optionId(id), label: id,
      description: `Use the declared ${id} Tool.`,
      consequence: `Paved test will execute ${id}.`,
    })),
    evidence, required: true, requiredAnswer: { type: "single-choice" },
    effect: "record-only", handler: "testing.select",
    candidates: resolution.candidates,
  }];
};
