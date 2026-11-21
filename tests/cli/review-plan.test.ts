import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planReview } from "../../cli/lib/review-plan.ts";

describe("review planning", () => {
  it("uses the total added and deleted lines at every threshold", () => {
    for (const [added, deleted, count, threshold] of [
      [24, 25, 0, "under-50"],
      [25, 25, 1, "50-to-300"],
      [150, 150, 1, "50-to-300"],
      [150, 151, 3, "over-300"],
    ] as const) {
      const plan = planReview([{ path: "src/widget.ts", added, deleted }]);
      assert.equal(plan.reviewers.length, count);
      assert.equal(plan.evidence.changedLines, added + deleted);
      assert.equal(plan.evidence.threshold, threshold);
    }
  });

  it("provides distinct independent lenses for large changes", () => {
    const plan = planReview([{ path: "src/widget.ts", added: 301, deleted: 0 }]);
    assert.deepEqual(plan.reviewers.map((reviewer) => reviewer.lens), ["Skeptic", "Architect", "Minimalist"]);
  });

  it("sums changes across files", () => {
    const plan = planReview([
      { path: "src/one.ts", added: 30, deleted: 0 },
      { path: "src/two.ts", added: 10, deleted: 10 },
    ]);
    assert.equal(plan.evidence.changedLines, 50);
    assert.equal(plan.reviewers.length, 1);
  });

  it("treats default sensitive paths as sensitive even for small changes", () => {
    for (const path of [
      "src/auth/login.ts", "db/migrations/001.sql", "src/permissions.ts",
      "src/money/ledger.ts", "src/payments/charge.ts", "src/personal-data/export.ts",
      ".config/AUTH/settings.json", "src/profile.ts",
    ]) {
      const plan = planReview([{ path, added: 1, deleted: 0 }]);
      assert.equal(plan.reviewers.length, 3, path);
      assert.equal(plan.evidence.threshold, "under-50");
      assert.ok(plan.evidence.sensitiveMatches.some((match) => match.path === path), path);
    }
  });

  it("adds configurable globs to defaults and reports matching paths and patterns", () => {
    const plan = planReview(
      [{ path: "src/secrets/key.ts", added: 0, deleted: 1 }],
      { sensitivePatterns: ["src/secrets/**"] },
    );
    assert.equal(plan.reviewers.length, 3);
    assert.deepEqual(plan.evidence.sensitiveMatches, [{ path: "src/secrets/key.ts", pattern: "src/secrets/**" }]);
    assert.equal(planReview([{ path: "src/auth.ts", added: 1, deleted: 0 }], { sensitivePatterns: [] }).reviewers.length, 3);
  });

  it("does not mistake unknown or binary counts for a trivial change", () => {
    for (const [added, deleted] of [[null, null], [null, 0], [0, null]] as const) {
      const plan = planReview([{ path: "assets/logo.bin", added, deleted }]);
      assert.equal(plan.reviewers.length, 3);
      assert.equal(plan.evidence.changedLines, null);
      assert.equal(plan.evidence.threshold, "unknown");
      assert.deepEqual(plan.evidence.unknownCountPaths, ["assets/logo.bin"]);
    }
    const mixed = planReview([
      { path: "src/widget.ts", added: 10, deleted: 0 },
      { path: "assets/logo.bin", added: null, deleted: null },
    ]);
    assert.equal(mixed.evidence.changedLines, null);
    assert.equal(mixed.reviewers.length, 3);
  });

  it("rejects invalid counts instead of understating the change", () => {
    for (const added of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => planReview([{ path: "src/file.ts", added, deleted: 0 }]), /nonnegative safe integer/);
    }
    assert.throws(() => planReview([{ path: "src/file.ts", added: Number.MAX_SAFE_INTEGER, deleted: 1 }]), /safe integer/);
  });
});
