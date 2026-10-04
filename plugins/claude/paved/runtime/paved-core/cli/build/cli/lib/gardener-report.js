import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { analyzeGardener } from "./gardener.js";
import { resolveSafePath } from "./safe-path.js";
const REPORTED = ".paved/generated/gardener/reported.json";
/** Advisory only: lists candidates not reported before, and never throws. */
export function reportNewProposals(projectRoot, coreRoot, analyze = analyzeGardener) {
    try {
        const { proposals } = analyze({ projectRoot, coreRoot });
        const path = resolveSafePath(projectRoot, REPORTED);
        const reported = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
        const fresh = proposals.filter((proposal) => proposal.status === "CANDIDATE" && reported[proposal.id] !== proposal.evidence_sha256);
        if (fresh.length === 0)
            return {};
        for (const proposal of fresh)
            reported[proposal.id] = proposal.evidence_sha256;
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, `${JSON.stringify(reported, null, 2)}\n`);
        return {
            proposals: fresh.map(({ id, problem, proposed_change, recommended_layer }) => ({ id, problem, proposed_change, recommended_layer })),
            adopt: "These proposals are advisory. Review and adopt them with paved gardener --json.",
        };
    }
    catch (error) {
        return { unavailable: error instanceof Error ? error.message : "Gardener analysis failed." };
    }
}
