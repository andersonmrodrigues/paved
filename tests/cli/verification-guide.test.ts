import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { initializeConsumer } from "../../cli/lib/generator-runtime.ts";
import { inspectVerificationGuides } from "../../cli/commands/status.ts";
import { dispatchCli } from "../../cli/runtime.ts";
import { cleanupTemporaryDirectories, temporaryDirectory } from "../helpers.ts";

const CORE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GUIDE = ".paved/skills/verify-shop/references/features.md";
afterEach(cleanupTemporaryDirectories);

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function feature(root: string, id: string, entrypoints: { kind: string; name: string }[], status = "active"): string {
  const path = `.paved/project/feature-map/${id}.yaml`;
  write(root, path, stringify({
    apiVersion: "paved/v1", kind: "Feature", id, name: id, summary: `The ${id} feature.`, status, confidence: "declared",
    code: { paths: [`src/${id}/**`], entrypoints: entrypoints.map((entry) => ({ ...entry, location: { path: `src/${id}/index.ts` } })) },
  }));
  return path;
}

const digest = (root: string, path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

function guide(root: string, frontmatter: Record<string, unknown> | undefined): void {
  write(root, GUIDE, `${frontmatter === undefined ? "" : `---\n${stringify(frontmatter)}---\n`}\n# Features\n\nStatus: draft.\n`);
}

/** A shop whose guide covers checkout and was written from the current feature map. */
function shop(root: string): void {
  const checkout = feature(root, "checkout", [{ kind: "http", name: "/checkout" }]);
  feature(root, "pricing-job", [{ kind: "job", name: "nightly-pricing" }]);
  guide(root, {
    apiVersion: "paved/v1", kind: "VerificationGuide", status: "draft",
    features: [{ id: "checkout", entrypoints: ["/checkout"] }],
    sources: [{ location: checkout, sha256: digest(root, checkout) }],
  });
}

const codes = (root: string) => inspectVerificationGuides(root, CORE).map((item) => item.code);

describe("verification guide drift", () => {
  it("reports nothing for a guide that matches the feature map, and ignores non-user-visible features", () => {
    const root = temporaryDirectory("paved-guide");
    shop(root);
    assert.deepEqual(inspectVerificationGuides(root, CORE), []);
  });

  it("reports features and entry points the guide covers that left the feature map", () => {
    const root = temporaryDirectory("paved-guide");
    shop(root);
    feature(root, "checkout", [{ kind: "http", name: "/cart/checkout" }]);
    const [missing] = inspectVerificationGuides(root, CORE).filter((item) => item.code === "PAVED_VERIFICATION_GUIDE_FEATURE_MISSING");
    assert.match(missing?.message ?? "", /checkout \/checkout/);
    feature(root, "checkout", [{ kind: "http", name: "/checkout" }], "removed");
    assert.ok(codes(root).includes("PAVED_VERIFICATION_GUIDE_FEATURE_MISSING"));
  });

  it("reports user-visible features the guide neither covers nor defers", () => {
    const root = temporaryDirectory("paved-guide");
    shop(root);
    feature(root, "sign-in", [{ kind: "ui", name: "/login" }]);
    const uncovered = inspectVerificationGuides(root, CORE).find((item) => item.code === "PAVED_VERIFICATION_GUIDE_FEATURE_UNCOVERED");
    assert.match(uncovered?.message ?? "", /sign-in/);
    assert.equal(uncovered?.severity, "warning");

    const checkout = ".paved/project/feature-map/checkout.yaml";
    guide(root, {
      apiVersion: "paved/v1", kind: "VerificationGuide", status: "draft", features: [{ id: "checkout" }], deferred: ["sign-in"],
      sources: [{ location: checkout, sha256: digest(root, checkout) }],
    });
    assert.deepEqual(codes(root), []);
  });

  it("reports stale or missing source digests", () => {
    const root = temporaryDirectory("paved-guide");
    shop(root);
    write(root, ".paved/project/feature-map/checkout.yaml", `${readFileSync(join(root, ".paved/project/feature-map/checkout.yaml"), "utf8")}# reviewed\n`);
    assert.deepEqual(codes(root), ["PAVED_VERIFICATION_GUIDE_STALE"]);
  });

  it("says when a guide records no coverage, and reports invalid frontmatter", () => {
    const root = temporaryDirectory("paved-guide");
    feature(root, "checkout", [{ kind: "http", name: "/checkout" }]);
    guide(root, undefined);
    const [untracked] = inspectVerificationGuides(root, CORE);
    assert.equal(untracked?.code, "PAVED_VERIFICATION_GUIDE_UNTRACKED");
    assert.equal(untracked.severity, "info");
    guide(root, { apiVersion: "paved/v1", kind: "VerificationGuide", status: "verified", features: [], sources: [] });
    assert.deepEqual(codes(root), ["PAVED_VERIFICATION_GUIDE_INVALID"]);
  });

  it("surfaces drift in doctor and status without writing anything", async () => {
    const root = temporaryDirectory("paved-guide-doctor");
    writeFileSync(join(root, "README.md"), "# Shop\n");
    initializeConsumer(CORE, root, "shop");
    shop(root);
    feature(root, "sign-in", [{ kind: "ui", name: "/login" }]);
    const before = JSON.stringify(readdirSync(root, { recursive: true }).sort());
    for (const command of ["doctor", "status"]) {
      const result = await dispatchCli({ argv: [command, "--project", root, "--json"], cwd: root, executablePath: join(CORE, "cli/index.ts") });
      assert.ok(result.diagnostics.some((item) => item.code === "PAVED_VERIFICATION_GUIDE_FEATURE_UNCOVERED"), JSON.stringify(result.diagnostics));
    }
    assert.equal(JSON.stringify(readdirSync(root, { recursive: true }).sort()), before);
  });
});
