import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { analyzeGardener, type GardenerProposal } from "../../gardener.ts";
import { resolveSafePath } from "../../safe-path.ts";
import { createRegistry } from "../../schemas.ts";
import type { AnswerValue } from "../answers.ts";
import type { DecisionContext, HandlerRegistration } from "../gate.ts";

function ruleFor(proposal: GardenerProposal) {
  const slug = proposal.id.replace(/^proposal-/, "");
  return {
    apiVersion: "paved/v1", kind: "Rule", id: `project.gardener.${slug}`,
    title: `Address recurring ${proposal.affected_components.join(", ")} issue`,
    rationale: `${proposal.problem} ${proposal.layer_rationale}`,
    applies_to: { paths: ["**/*"] },
    rule: proposal.proposed_change,
    enforcement: { mechanism: "agent", layer: "rule" },
    severity: "warning",
    verification: `Review evidence for the proposed change: ${proposal.expected_impact}`,
    references: proposal.provenance.sources.map((source) => source.location).sort(),
  };
}

function apply(answer: AnswerValue, context: DecisionContext): readonly string[] {
  if (answer === "decline") return [];
  if (answer !== "adopt") throw new Error(`Unknown gardener option: ${String(answer)}.`);
  const proposals = analyzeGardener({ projectRoot: context.projectRoot, coreRoot: context.coreRoot }).proposals
    .filter((proposal) => proposal.status === "CANDIDATE");
  const registry = createRegistry(join(context.coreRoot, "schemas"), ["paved/v1"]);
  const files = proposals.map((proposal) => ({ path: `.paved/rules/gardener/${proposal.id}.yaml`, document: ruleFor(proposal) }));
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
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, stringify(file.document));
  }
  return files.map((file) => file.path);
}

export const gardenerHandler: HandlerRegistration = {
  effect: "config-additive", apply, reject: (answer) => answer === "decline",
};
