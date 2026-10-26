import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { loadYaml } from "./documents.ts";
import { coveredTypes, type EvidenceRecord } from "./evidence.ts";
import { resolveSafePath } from "./safe-path.ts";
import { runSourceRoot, type Run } from "./workflow-runs.ts";
import { UNCHANGED_HANDLER, type WorkflowContract } from "./workflows.ts";

interface ChangeDiff { readonly files: string[]; readonly patch: string }

// Paved state is not part of the change it records.
const PATHSPEC = ["--", ".", ":(exclude).paved", ":(exclude).paved.update-backup"];

function git(projectRoot: string, args: readonly string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  // `git diff --no-index` exits 1 when the files differ, which is the expected case.
  return { ok: result.error === undefined && (result.status === 0 || (args.includes("--no-index") && result.status === 1)), stdout: result.stdout ?? "" };
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** The change since the run started: committed, staged, unstaged and untracked files, against the run's revision. */
function collectChange(projectRoot: string, revision: string): ChangeDiff | undefined {
  if (git(projectRoot, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") return undefined;
  // A run started before the repository had a commit changed every file it now holds.
  const base = revision === "unversioned"
    ? undefined
    : [revision, "HEAD"].find((ref) => git(projectRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok);
  const untracked = lines(git(projectRoot, ["ls-files", "--others", "--exclude-standard", ...PATHSPEC]).stdout);
  const changed = base === undefined
    ? [...lines(git(projectRoot, ["ls-files", "--cached", ...PATHSPEC]).stdout), ...untracked]
    : [...lines(git(projectRoot, ["diff", "--name-only", base, ...PATHSPEC]).stdout), ...untracked];
  const added = base === undefined ? changed : untracked;
  let patch = base === undefined ? "" : git(projectRoot, ["diff", "--no-color", base, ...PATHSPEC]).stdout;
  for (const file of added) patch += git(projectRoot, ["diff", "--no-color", "--no-index", "--", "/dev/null", file]).stdout;
  return { files: [...new Set(changed)].sort((a, b) => a.localeCompare(b, "en")), patch };
}

interface ProfileDocument { readonly unavailable?: readonly { type: string; reason: string }[] }

function workflowPlan(workflow: WorkflowContract, authoritative: EvidenceRecord): EvidenceRecord["plan"] {
  const all = (key: "required" | "recommended") => workflow.phases.flatMap((phase) => phase.verification?.[key] ?? []);
  const required = [...new Set([...all("required"), ...authoritative.plan.required])].sort();
  const recommended = [...new Set(all("recommended"))].filter((type) => !required.includes(type)).sort();
  const evidence = [...new Set([...workflow.evidence.required, ...authoritative.plan.evidence, "diff"])].sort();
  return { required, ...(recommended.length ? { recommended } : {}), evidence } as EvidenceRecord["plan"];
}

/**
 * Builds the workflow evidence record from what Paved already holds: the authoritative
 * verification record, the run's change and the workflow's verification plan.
 */
export function writeWorkflowEvidence(input: {
  readonly projectRoot: string;
  readonly run: Run;
  readonly workflow: WorkflowContract;
  readonly summary: string;
}): { path: string } | { problem: string } {
  const { projectRoot, run, workflow } = input;
  if (!run.evidence) return { problem: "The run has no authoritative verification evidence to build on." };
  const authoritative = loadYaml(resolveSafePath(projectRoot, run.evidence)) as EvidenceRecord & { verification: unknown };
  const change = collectChange(runSourceRoot(projectRoot, run), run.revision);
  if (!change) return { problem: "The project is not a Git working tree, so Paved cannot derive the change diff." };
  // Work the user confirmed was already done before the run legitimately has an empty diff.
  const preExisting = run.decisions?.some((decision) => decision.handler === UNCHANGED_HANDLER && decision.answer === "already-done") === true;
  if (change.files.length === 0 && !preExisting) return { problem: "No changed file was found since the run started." };

  const createdAt = new Date().toISOString();
  // Each recording gets its own files, so evidence a reopened run already recorded is never rewritten.
  const attempt = run.events.filter((event) => event.type === "evidence-recorded" && event.phase === "evidence").length + 1;
  const suffix = attempt === 1 ? "" : `-${attempt}`;
  const diffRef = `.paved/generated/evidence/${run.id}${suffix}.diff`;
  const recordRef = `.paved/generated/evidence/${run.id}-workflow${suffix}.yaml`;
  const plan = workflowPlan(workflow, authoritative);
  const covered = new Set(authoritative.checks.filter((check) => check.status === "passed").flatMap(coveredTypes));
  const profilePath = resolveSafePath(projectRoot, ".paved/verification/profile.yaml");
  const unavailable = existsSync(profilePath) ? (loadYaml(profilePath) as ProfileDocument).unavailable ?? [] : [];
  const gaps = (plan.recommended ?? []).filter((type) => !covered.has(type)).map((type) => ({
    check_type: type,
    description: `No ${type} check ran for this change.`,
    reason: unavailable.find((item) => item.type === type)?.reason ?? "The verification profile configures no check of this type.",
    risk: "low",
  }));
  const record = {
    apiVersion: "paved/v1", kind: "Evidence", id: `${run.id}-workflow${suffix}`, created_at: createdAt,
    producer: { agent: "paved-cli", workflow: workflow.id, run: run.id },
    verification: authoritative.verification,
    retention: "local",
    change: { ...authoritative.change, summary: preExisting && change.files.length === 0 ? `${input.summary} (already in the repository before the run started)` : input.summary, files: change.files },
    plan,
    claims: authoritative.claims,
    checks: authoritative.checks,
    artifacts: [
      ...(authoritative.artifacts ?? []),
      {
        id: "change-diff", kind: "diff", description: "Diff of the change since the run started.",
        recorded_by: "paved", revision: authoritative.change.revision, created_at: createdAt,
        source: { type: "file", location: diffRef, sha256: sha(change.patch) },
      },
    ],
    ...(gaps.length ? { gaps } : {}),
    completion: authoritative.completion,
  };
  for (const [ref, content] of [[diffRef, change.patch], [recordRef, stringify(record)]] as const) {
    const path = resolveSafePath(projectRoot, ref);
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, content);
  }
  return { path: join(projectRoot, recordRef) };
}
