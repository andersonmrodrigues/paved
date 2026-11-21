import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "./documents.ts";
import { resolveSafePath } from "./safe-path.ts";
import { createRegistry } from "./schemas.ts";

export class ReviewPolicyError extends Error {}

export function loadReviewSensitivePatterns(projectRoot: string, coreRoot: string): string[] {
  let path: string;
  try {
    path = resolveSafePath(projectRoot, ".paved/review.yaml");
  } catch {
    throw new ReviewPolicyError("The project review policy is invalid or unsafe.");
  }
  if (!existsSync(path)) return [];

  let policy: unknown;
  try {
    policy = loadYaml(path);
  } catch {
    throw new ReviewPolicyError("The project review policy is invalid or unsafe.");
  }
  const validation = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]).validate(policy);
  if (!validation.valid || (policy as { kind?: unknown } | null)?.kind !== "ReviewPolicy") {
    throw new ReviewPolicyError("The project review policy is invalid or unsafe.");
  }
  return (policy as { sensitive_paths: string[] }).sensitive_paths;
}
