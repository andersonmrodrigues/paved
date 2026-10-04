import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GardenerProposal, GardenerResult } from "../../cli/lib/gardener.ts";
import { reportNewProposals } from "../../cli/lib/gardener-report.ts";

let projectRoot = "";
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), "paved-gardener-report-")); });
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

const proposal = (id: string, sha: string, status = "CANDIDATE") => ({
  id, status, evidence_sha256: sha, problem: `Problem ${id}`, proposed_change: `Change ${id}`, recommended_layer: "rule",
}) as unknown as GardenerProposal;
const analyzer = (proposals: GardenerProposal[]) => (): GardenerResult => ({ consumer: "consumer", observations: [], proposals });

describe("gardener report at the end of execute", () => {
  it("lists a new candidate once", () => {
    const first = reportNewProposals(projectRoot, "", analyzer([proposal("g-1", "a")]));
    assert.deepEqual(first.proposals?.map((item) => item.id), ["g-1"]);
    assert.match(first.adopt ?? "", /paved gardener/);
    assert.deepEqual(reportNewProposals(projectRoot, "", analyzer([proposal("g-1", "a")])), {});
  });

  it("lists it again when its evidence changes", () => {
    reportNewProposals(projectRoot, "", analyzer([proposal("g-1", "a")]));
    assert.deepEqual(reportNewProposals(projectRoot, "", analyzer([proposal("g-1", "b")])).proposals?.map((item) => item.id), ["g-1"]);
  });

  it("never lists reviewed proposals", () => {
    assert.deepEqual(reportNewProposals(projectRoot, "", analyzer([proposal("g-2", "a", "REJECTED")])), {});
  });

  it("reports an analysis failure without throwing", () => {
    const failed = reportNewProposals(projectRoot, "", () => { throw new Error("Consumer manifest has no project name."); });
    assert.equal(failed.unavailable, "Consumer manifest has no project name.");
  });
});
