import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fingerprintOf } from "../../cli/lib/decisions/fingerprint.ts";
import {
  DecisionStoreError, listDecisions, readDecision, writeDecision,
} from "../../cli/lib/decisions/store.ts";
import type { Decision } from "../../cli/lib/decisions/record.ts";

const coreRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "paved-decision-store-"));
  workspaces.push(path);
  return path;
}

after(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

function decision(id: string, createdAt = "2026-09-28T00:00:00.000Z"): Decision {
  const evidence = [{ type: "file" as const, location: "pom.xml", sha256: "a".repeat(64) }];
  return {
    apiVersion: "paved/v1", kind: "Decision", id, scope: "project", command: "verify",
    category: "material", authored_by: "runtime", question: "q", reason: "r",
    options: [{ id: "all", label: "All", description: "d", consequence: "c" }],
    evidence, required: true, required_answer: { type: "single-choice" },
    risk: "low", reversibility: "reversible", answer_channel: "relayed",
    status: "PENDING", fingerprint: fingerprintOf(evidence, ["a"]), created_at: createdAt,
  };
}

describe("project decision store", () => {
  it("round-trips a decision", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-0123456789abcdef0123"));
    const loaded = readDecision(project, "d-0123456789abcdef0123");
    assert.equal(loaded?.id, "d-0123456789abcdef0123");
    assert.equal(loaded?.status, "PENDING");
  });

  it("writes snake_case YAML under .paved/decisions/", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-0123456789abcdef0123"));
    const raw = readFileSync(join(project, ".paved/decisions/d-0123456789abcdef0123.yaml"), "utf8");
    assert.match(raw, /answer_channel: relayed/);
    assert.doesNotMatch(raw, /answerChannel/);
  });

  it("returns undefined for an absent decision", () => {
    assert.equal(readDecision(workspace(), "d-ffffffffffffffffffff"), undefined);
  });

  it("lists decisions in a stable order", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-bbbbbbbbbbbbbbbbbbbb", "2026-09-28T00:02:00.000Z"));
    writeDecision(project, coreRoot, decision("d-aaaaaaaaaaaaaaaaaaaa", "2026-09-28T00:01:00.000Z"));
    assert.deepEqual(
      listDecisions(project).map((item) => item.id),
      ["d-aaaaaaaaaaaaaaaaaaaa", "d-bbbbbbbbbbbbbbbbbbbb"],
    );
  });

  it("refuses a malformed id before touching the filesystem", () => {
    assert.throws(() => readDecision(workspace(), "../../etc/passwd"), DecisionStoreError);
    assert.throws(() => readDecision(workspace(), "d-NOTHEX"), DecisionStoreError);
  });

  it("refuses to write a schema-invalid decision", () => {
    const invalid = { ...decision("d-0123456789abcdef0123"), question: "" } as Decision;
    assert.throws(() => writeDecision(workspace(), coreRoot, invalid), DecisionStoreError);
  });

  it("survives a re-read after the process that wrote it is gone", () => {
    const project = workspace();
    writeDecision(project, coreRoot, decision("d-0123456789abcdef0123"));
    // A fresh read with no in-memory state is exactly what an agent restart does.
    assert.equal(readDecision(project, "d-0123456789abcdef0123")?.id, "d-0123456789abcdef0123");
  });
});
