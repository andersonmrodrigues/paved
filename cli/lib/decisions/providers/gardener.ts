import { analyzeGardener } from "../../gardener.ts";
import type { DecisionProvider } from "../gate.ts";

export const gardenerProvider: DecisionProvider = (context) => {
  const result = analyzeGardener({ projectRoot: context.projectRoot, coreRoot: context.coreRoot });
  const proposals = result.proposals.filter((proposal) => proposal.status === "CANDIDATE");
  if (proposals.length === 0) return [];
  const sources = [...new Map(proposals.flatMap((proposal) => proposal.provenance.sources).map((source) => [source.location, source])).values()]
    .sort((a, b) => a.location.localeCompare(b.location, "en"));
  return [{
    scope: "project",
    question: `Should Paved adopt ${proposals.length} recurring improvement proposal(s) as project rules?`,
    reason: proposals.map((proposal) => `${proposal.problem} ${proposal.proposed_change} Impact: ${proposal.expected_impact} Uncertainty: ${proposal.uncertainty}`).join(" "),
    options: [
      { id: "adopt", label: "Adopt proposals", description: "Write corresponding project rules for review.", consequence: "New rules will be added under .paved/rules/gardener/." },
      { id: "decline", label: "Decline", description: "Leave proposals informational.", consequence: "No rule files will be written." },
    ],
    recommended: "adopt", evidence: sources, required: false,
    requiredAnswer: { type: "single-choice" }, effect: "config-additive",
    handler: "gardener.adopt", candidates: proposals.map((proposal) => proposal.id).sort(),
  }];
};
