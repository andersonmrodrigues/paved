import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { AGENT_ASSIGNABLE_EFFECTS, EFFECT_TIERS, tierFor } from "../../cli/lib/decisions/effects.ts";
import { ApprovalError, decisionDigest, readDecisionApproval } from "../../cli/lib/decisions/approval.ts";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { verificationProvider } from "../../cli/lib/decisions/providers/verification.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

describe("security invariants an answer cannot override", () => {
  function project(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `paved-security-${name}-`));
    approvalWorkspaces.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "README.md"), `# ${name}\n`);
    initializeConsumer(coreRoot, root, name);
    return root;
  }

  it("fails testing rather than asking when no authorized ToolImplementation exists", async () => {
    const root = project("no-testing-tool");
    const result = await dispatchCli({ argv: ["test", "--project", root, "--json"], cwd: root, executablePath: join(coreRoot, "cli/index.ts") });
    assert.equal(result.status, "failed");
    assert.equal(result.decisions, undefined);
    assert.ok(result.diagnostics.some((item) => /TOOL|IMPLEMENTATION|TEST/i.test(item.code)));
  });

  it("stores free text as decision data without executing it", async () => {
    const root = project("free-text-data");
    const runStart = await dispatchCli({ argv: ["intent", "Describe", "the", "change", "--workflow", "feature", "--because", "The request asks for new behavior.", "--project", root, "--json"], cwd: root, executablePath: join(coreRoot, "cli/index.ts") });
    const run = (runStart.data as { run: string }).run;
    const readme = readFileSync(join(root, "README.md"));
    const marker = join(root, "should-not-be-created-by-free-text");
    const raised = await dispatchCli({ argv: [
      "decision", "raise", "--project", root, "--json", "--decision", JSON.stringify({
        run, question: "What note should be retained?", reason: "The run needs the user's exact text.",
        options: [{ id: "text", label: "Text", description: "Supply a note.", consequence: "The note is stored as data." }],
        evidence: [{ type: "file", location: "README.md", sha256: createHash("sha256").update(readme).digest("hex") }],
        required: true, requiredAnswer: { type: "free-text", pattern: "^[a-zA-Z0-9/ ._-]+$", max_length: 500 },
      }),
    ], cwd: root, executablePath: join(coreRoot, "cli/index.ts") });
    assert.equal(raised.status, "success", JSON.stringify(raised));
    const id = (raised.data as { id: string }).id;
    const payload = `touch ${marker}`;
    const resumed = await dispatchCli({ argv: [
      "intent", "--run", run, "--advance", "--note", "Retain the user note.",
      "--answer", `${id}=${payload}`, "--answered-by", "tester@example.com", "--project", root, "--json",
    ], cwd: root, executablePath: join(coreRoot, "cli/index.ts") });
    assert.notEqual(resumed.status, "failed", JSON.stringify(resumed));
    const stored = parse(readFileSync(join(root, ".paved/generated/runs", `${run}.yaml`), "utf8")) as {
      decisions: { id: string; answer: string }[];
    };
    assert.equal(stored.decisions.find((decision) => decision.id === id)?.answer, payload);
    assert.equal(existsSync(marker), false);
  });

  it("does not let an answer override lock integrity failure", async () => {
    const root = project("tampered-lock");
    const lockPath = join(root, ".paved/paved.lock");
    const lock = parse(readFileSync(lockPath, "utf8")) as { core: { sha256: string } };
    lock.core.sha256 = "not-a-sha256-digest";
    writeFileSync(lockPath, stringify(lock));
    const result = await dispatchCli({
      argv: ["update", "--project", root, "--answer", "d-0123456789abcdef0123=proceed", "--answered-by", "tester@example.com", "--json"],
      cwd: root, executablePath: join(coreRoot, "cli/index.ts"),
    });
    assert.equal(result.status, "failed");
    assert.ok(result.diagnostics.some((item) => item.code.startsWith("PAVED_LOCK_")));
  });

  it("rejects a decision id that escapes the project root", async () => {
    const root = approvalWorkspace();
    const result = await dispatchCli({ argv: ["decision", "show", "../../etc/passwd", "--project", root, "--json"], cwd: root, executablePath: join(coreRoot, "cli/index.ts") });
    assert.equal(result.status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /root:/);
  });

  it("keeps secret-like build command contents out of verification decisions", () => {
    const root = approvalWorkspace();
    const secret = "AKIAIOSFODNN7EXAMPLE-password";
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: `echo ${secret}` } }));
    const candidates = verificationProvider({ projectRoot: root, coreRoot, command: "verify", answers: [] });
    assert.ok(candidates.length > 0);
    assert.doesNotMatch(JSON.stringify(candidates), /AKIA|password|secret/i);
  });
});
