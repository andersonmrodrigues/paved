import { join } from "node:path";
import { loadMarkdown, loadYaml } from "../../cli/lib/documents.ts";
import { loadEvidenceRegistry } from "../../cli/lib/evidence.ts";
import type { SkillContract } from "../../cli/lib/skills.ts";
import type { WorkflowContext, WorkflowContract, WorkflowFiles } from "../../cli/lib/workflows.ts";
import { coreSkills, coreTools } from "../core/registries.ts";
import { at } from "../helpers.ts";

// The phase enum in the common schema is the single source of the canonical order.
export const CANONICAL_ORDER = (loadYaml(at("schemas", "common.schema.yaml")) as { $defs: { phase: { enum: string[] } } })
  .$defs.phase.enum;

/** The Core as the workflow checks see it: skills with bodies, tool safety, check support. */
export function coreWorkflowContext(): WorkflowContext {
  const skills = new Map(
    coreSkills().map((s) => {
      const contract = loadYaml(join(s.dir, "skill.yaml")) as SkillContract;
      return [contract.id, { ...contract, body: loadMarkdown(join(s.dir, "SKILL.md")).body }];
    }),
  );
  const toolSafety = new Map(coreTools().map((t) => [t.document.id, String(t.document.safety)]));
  const supports = new Map(
    Object.entries(loadEvidenceRegistry(at("core", "verification", "registry.yaml")).checkTypes).map(([type, v]) => [
      type,
      v.supports,
    ]),
  );
  return { phaseOrder: CANONICAL_ORDER, skills, toolSafety, supports };
}

export function loadWorkflow(dir: string): WorkflowFiles {
  return {
    contract: loadYaml(join(dir, "workflow.yaml")) as WorkflowContract,
    body: loadMarkdown(join(dir, "WORKFLOW.md")).body,
  };
}
