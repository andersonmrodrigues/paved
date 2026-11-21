import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deliveryHandler } from "../../cli/commands/delivery.ts";
import { deliveryApprovalPath, deliveryApprovalProblem, type DeliveryApproval } from "../../cli/lib/delivery-approval.ts";
import type { CommandInvocation } from "../../cli/runtime.ts";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const approval: DeliveryApproval = {
  apiVersion: "paved/v1",
  kind: "DeliveryApproval",
  target: "main",
  change: "42",
  head: "4f2c9e1b7a3d8c21e5f60a9b2d4c6e8f01a3b5c7",
  patch_id: "a".repeat(40),
  approved_by: "maintainer",
  approved_at: "2026-11-21T00:00:00.000Z",
};
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("patch-bound delivery approval", () => {
  it("accepts only the action, target, head and patch the human approved", () => {
    const expected = { target: "main", change: "42", head: approval.head, patch_id: approval.patch_id };
    assert.equal(deliveryApprovalProblem(approval, expected), undefined);
    assert.match(deliveryApprovalProblem(approval, { ...expected, change: "43" }) ?? "", /different change request/);
    assert.match(deliveryApprovalProblem(approval, { ...expected, target: "release" }) ?? "", /different target/);
    assert.match(deliveryApprovalProblem(approval, { ...expected, head: "b".repeat(40) }) ?? "", /different head/);
    assert.match(deliveryApprovalProblem(approval, { ...expected, patch_id: "c".repeat(40) }) ?? "", /different patch/);
  });

  it("refuses an approval without a person identity or complete record shape", () => {
    const expected = { target: "main", change: "42", head: approval.head, patch_id: approval.patch_id };
    assert.match(deliveryApprovalProblem({ ...approval, approved_by: "agent" }, expected) ?? "", /human identity/);
    assert.match(deliveryApprovalProblem({ ...approval, approved_by: "   " }, expected) ?? "", /human identity/);
    assert.match(deliveryApprovalProblem({ ...approval, approved_by: "human" }, expected) ?? "", /human identity/);
    assert.match(deliveryApprovalProblem({ ...approval, patch_id: "not-a-patch" }, expected) ?? "", /approval is invalid/);
  });
});

describe("delivery merge boundary", () => {
  it("does not invoke a merge when the current project is not delivery-ready", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-delivery-"));
    const calls: string[] = [];
    const invocation: CommandInvocation = {
      command: "delivery",
      flags: {
        adapters: [], dryRun: false, json: true, noGenerate: false, areas: [], answers: [], parts: [], intentInputs: [],
        correctionEvidence: [], changedPaths: [], base: "main", change: "42", head: approval.head,
      },
      selectors: ["merge"],
      paths: { cwd: projectRoot, projectRoot, sourceRoot: projectRoot, coreRoot: ROOT },
      rawArgv: [],
    };

    try {
      const result = deliveryHandler(invocation, {
        run: (command) => {
          calls.push(command);
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      assert.equal(result.status, "warning");
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PAVED_DELIVERY_NOT_READY"));
      assert.deepEqual(calls, []);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does not merge when the saved approval is for another patch", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-delivery-"));
    const patchId = "a".repeat(40);
    const action = { target: "main", change: "42", head: approval.head, patch_id: patchId };
    const path = deliveryApprovalPath(action);
    mkdirSync(join(projectRoot, path, ".."), { recursive: true });
    writeFileSync(join(projectRoot, path), stringify({ ...approval, ...action, patch_id: "b".repeat(40) }));
    const calls: string[][] = [];
    const invocation: CommandInvocation = {
      command: "delivery",
      flags: {
        adapters: [], dryRun: false, json: true, noGenerate: false, areas: [], answers: [], parts: [], intentInputs: [],
        correctionEvidence: [], changedPaths: [], base: action.target, change: action.change, head: action.head,
      },
      selectors: ["merge"],
      paths: { cwd: projectRoot, projectRoot, sourceRoot: projectRoot, coreRoot: ROOT },
      rawArgv: [],
    };

    try {
      const result = deliveryHandler(invocation, {
        readiness: () => ({
          target: action.target, ready: true, recordedPatchId: patchId, headPatchId: patchId, uncommitted: false,
        }),
        run: (command, args) => {
          calls.push([command, ...args]);
          if (command === "git") return { status: 0, stdout: `${action.head}\n`, stderr: "" };
          if (args[1] === "view") {
            return { status: 0, stdout: JSON.stringify({ baseRefName: action.target, headRefOid: action.head }), stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      assert.equal(result.status, "warning");
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PAVED_DELIVERY_APPROVAL_INVALID"));
      assert.equal(calls.some((call) => call[0] === "gh" && call[2] === "merge"), false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("merges only the approved head after local freshness and remote identity checks pass", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "paved-delivery-"));
    const action = { target: "main", change: "42", head: approval.head, patch_id: approval.patch_id };
    const path = deliveryApprovalPath(action);
    mkdirSync(join(projectRoot, path, ".."), { recursive: true });
    writeFileSync(join(projectRoot, path), stringify({ ...approval, ...action }));
    const calls: string[][] = [];
    const invocation: CommandInvocation = {
      command: "delivery",
      flags: {
        adapters: [], dryRun: false, json: true, noGenerate: false, areas: [], answers: [], parts: [], intentInputs: [],
        correctionEvidence: [], changedPaths: [], base: action.target, change: action.change, head: action.head,
      },
      selectors: ["merge"],
      paths: { cwd: projectRoot, projectRoot, sourceRoot: projectRoot, coreRoot: ROOT },
      rawArgv: [],
    };

    try {
      const result = deliveryHandler(invocation, {
        readiness: () => ({
          target: action.target, ready: true, recordedPatchId: action.patch_id, headPatchId: action.patch_id, uncommitted: false,
        }),
        run: (command, args) => {
          calls.push([command, ...args]);
          if (command === "git") return { status: 0, stdout: `${action.head}\n`, stderr: "" };
          if (args[1] === "view") {
            return { status: 0, stdout: JSON.stringify({ baseRefName: action.target, headRefOid: action.head }), stderr: "" };
          }
          return { status: 0, stdout: "Merged", stderr: "" };
        },
      });

      assert.equal(result.status, "success", JSON.stringify(result));
      assert.deepEqual(calls.at(-1), ["gh", "pr", "merge", action.change, "--squash", "--match-head-commit", action.head]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
