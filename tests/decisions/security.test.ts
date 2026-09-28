import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AGENT_ASSIGNABLE_EFFECTS, EFFECT_TIERS, tierFor } from "../../cli/lib/decisions/effects.ts";
import { ApprovalError, decisionDigest, readDecisionApproval } from "../../cli/lib/decisions/approval.ts";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const approvalWorkspaces: string[] = [];
after(() => { for (const path of approvalWorkspaces) rmSync(path, { recursive: true, force: true }); });

function approvalWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), "paved-approval-"));
  approvalWorkspaces.push(path);
  mkdirSync(join(path, ".paved/approvals"), { recursive: true });
  return path;
}

function irreversible(): Decision {
  const evidence = [{ type: "file" as const, location: "src/App.java", sha256: "a".repeat(64) }];
  return {
    apiVersion: "paved/v1", kind: "Decision", id: "d-0123456789abcdef0123",
    scope: "project", command: "doctor", category: "material", authored_by: "runtime",
    question: "Apply this repair?", reason: "Generated context no longer matches its sources.",
    options: [{ id: "apply", label: "Apply", description: "d", consequence: "c" }],
    evidence, required: true, required_answer: { type: "single-choice" },
    risk: "high", reversibility: "irreversible", answer_channel: "human-authored",
    status: "ASKED", fingerprint: fingerprintOf(evidence, ["apply"]),
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

function writeApproval(project: string, decision: Decision, body: Record<string, unknown>): void {
  writeFileSync(join(project, `.paved/approvals/${decision.id}.json`), JSON.stringify(body));
}

describe("human-authored approval channel", () => {
  it("accepts a well-formed approval", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.equal(readDecisionApproval(project, decision)?.decided_by, "anderson@example.com");
  });

  it("returns undefined when no approval exists", () => {
    assert.equal(readDecisionApproval(approvalWorkspace(), irreversible()), undefined);
  });

  it("rejects self-approval by the agent", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "agent", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("rejects an approval bound to different decision content", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: "b".repeat(64), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("rejects an approval naming a different decision", () => {
    const project = approvalWorkspace();
    const decision = irreversible();
    writeApproval(project, decision, {
      decision: "d-ffffffffffffffffffff", decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("rejects an approval for a decision that is not ASKED", () => {
    const project = approvalWorkspace();
    const decision = { ...irreversible(), status: "PENDING" as const };
    writeApproval(project, decision, {
      decision: decision.id, decision_sha256: decisionDigest(decision), answer: "apply",
      decided_by: "anderson@example.com", decided_at: "2026-09-28T00:05:00.000Z",
    });
    assert.throws(() => readDecisionApproval(project, decision), ApprovalError);
  });

  it("changes the digest when the question or options change, invalidating stale approvals", () => {
    const decision = irreversible();
    assert.notEqual(decisionDigest(decision), decisionDigest({ ...decision, question: "Apply this different repair?" }));
  });
});

describe("effect class tiering", () => {
  it("routes reversible effects through the relayed channel", () => {
    assert.equal(tierFor("record-only").channel, "relayed");
    assert.equal(tierFor("config-additive").channel, "relayed");
  });

  it("routes recoverable effects through the relayed channel", () => {
    assert.equal(tierFor("config-mutating").channel, "relayed");
    assert.equal(tierFor("lock-transaction").channel, "relayed");
  });

  it("forces irreversible effects onto the human-authored channel", () => {
    assert.equal(tierFor("repository-mutating").channel, "human-authored");
    assert.equal(tierFor("destructive").channel, "human-authored");
  });

  it("forces plan approval onto the human-authored channel regardless of effect", () => {
    // reversible base (record-only is already relayed)
    assert.equal(tierFor("record-only", { planApproval: true }).channel, "human-authored");
    // recoverable base (config-mutating is already relayed)
    assert.equal(tierFor("config-mutating", { planApproval: true }).channel, "human-authored");
    // irreversible base (destructive is already human-authored, override is idempotent)
    assert.equal(tierFor("destructive", { planApproval: true }).channel, "human-authored");
  });

  it("keeps every irreversible tier on the human-authored channel", () => {
    for (const [effect, tier] of Object.entries(EFFECT_TIERS)) {
      if (tier.reversibility === "irreversible") {
        assert.equal(tier.channel, "human-authored", `${effect} must be human-authored`);
      }
    }
  });

  it("does not let an agent assign an irreversible effect class", () => {
    assert.deepEqual([...AGENT_ASSIGNABLE_EFFECTS], ["record-only"]);
  });

  it("throws on unknown effect class instead of returning a malformed tier", () => {
    assert.throws(
      () => tierFor("unknown-effect" as never),
      /Unknown effect class/
    );
  });

  it("returns a defensive copy that can be mutated without affecting the table", () => {
    const tier = tierFor("destructive");
    // Attempt to mutate the returned tier (copy, not frozen)
    (tier as any).channel = "relayed";
    // Verify the mutation did not persist to the canonical entry
    assert.equal(tierFor("destructive").channel, "human-authored");
  });

  it("freezes EFFECT_TIERS to prevent direct mutation of existing entries", () => {
    assert.throws(
      () => {
        (EFFECT_TIERS as never as Record<string, { channel: string }>).destructive!.channel = "relayed";
      },
      TypeError
    );
    // Verify the entry survived the attack intact
    assert.equal(tierFor("destructive").channel, "human-authored");
  });

  it("freezes EFFECT_TIERS to prevent adding new keys to the table", () => {
    assert.throws(
      () => {
        (EFFECT_TIERS as never as Record<string, unknown>)["invented"] = {};
      },
      TypeError
    );
    // Verify the table survived the attack intact
    assert.equal(tierFor("destructive").channel, "human-authored");
  });
});
