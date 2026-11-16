import { analyzeGardener } from "../../gardener.js";
import { correctionHandlerKey, correctionProposals } from "../../gardener-corrections.js";
export const gardenerProvider = (context) => {
    const result = analyzeGardener({ projectRoot: context.projectRoot, coreRoot: context.coreRoot });
    const proposals = result.proposals.filter((proposal) => proposal.status === "CANDIDATE");
    if (proposals.length === 0)
        return [];
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
/** One decision per correction proposal, so a person adopts or declines each stated rule on its own. */
export const correctionProvider = (context) => correctionProposals(context.projectRoot, context.coreRoot).map((proposal) => ({
    scope: "project",
    question: `Adopt the correction a person stated as project rule ${proposal.rule_id}?`,
    reason: `Stated ${proposal.occurrences === 1 ? "once" : `${proposal.occurrences} times`}: "${proposal.rule}". Adopting writes ${proposal.proposal_for}, enforced by the agent at severity warning for every file; narrow its scope and severity there.`,
    options: [
        { id: "adopt", label: "Adopt as a project rule", description: `Write ${proposal.proposal_for} from ${proposal.path}.`, consequence: "Workflows, evidence and reviews cite the rule from now on." },
        { id: "decline", label: "Decline", description: "Keep it out of the project rules.", consequence: "Nothing is written; restating it with new evidence asks again." },
    ],
    recommended: "adopt",
    evidence: [{ type: "file", location: proposal.path, sha256: proposal.sha256 }],
    required: false,
    requiredAnswer: { type: "single-choice" },
    effect: "config-additive",
    handler: correctionHandlerKey(proposal.path),
    candidates: [proposal.path],
}));
