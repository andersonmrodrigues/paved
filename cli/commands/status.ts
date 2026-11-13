import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDiagnostic, createResult, type CommandResult, type Diagnostic, type ResultStatus } from "../result.ts";
import type { CommandInvocation } from "../runtime.ts";
import { hasContextDrift, inspectConsumer, type ConsumerInspection } from "../lib/consumer-state.ts";
import { discoverAgentCommands } from "../lib/agent-commands.ts";
import { agentsBlockInvalidDiagnostic, inspectAgentsBlock } from "../lib/agents-block.ts";
import { runDecisionGate } from "../lib/decisions/gate.ts";
import { DecisionStoreError } from "../lib/decisions/store.ts";
import { repairProvider } from "../lib/decisions/providers/repair.ts";
import { repairHandler } from "../lib/decisions/handlers/repair.ts";
import { isOpen, runBelongsTo, runSourceRoot, scanRuns, type Run } from "../lib/workflow-runs.ts";
import { changedSinceVerification, fingerprint } from "../lib/workflow-gates/shared.ts";
import { inspectVerificationConfig } from "../lib/verification-runner.ts";
import { loadMarkdown, loadYaml } from "../lib/documents.ts";
import { resolveSafePath } from "../lib/safe-path.ts";
import { createRegistry } from "../lib/schemas.ts";

function statusFor(diagnostics: readonly Diagnostic[]): ResultStatus {
  if (diagnostics.some((diagnostic) => diagnostic.category !== "findings")) return "failed";
  return diagnostics.some((diagnostic) => diagnostic.severity !== "info") ? "warning" : "success";
}

export function statusData(inspection: ConsumerInspection): Record<string, unknown> {
  const waiting = inspection.pendingDecisions.filter((item) => item.required);
  const unavailableCommands = discoverAgentCommands(inspection.projectRoot, inspection.coreRoot, inspection.sourceRoot).commands
    .filter((command) => !command.available)
    .map((command) => ({
      name: command.name,
      reason: command.reason ?? "Unavailable in the current project state.",
      recommendedNextAction: command.recommendedNextAction ?? "Run paved status for guidance.",
    }));
  const answerCommand = `paved ${waiting[0]?.command === "doctor" ? "status" : waiting[0]?.command ?? "status"}`;
  const drifted = hasContextDrift(inspection);
  const baseAction = waiting.length > 0
    ? inspection.pendingApprovals.length > 0
      ? `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Review the pending approval ids, then relay approved answers with ${answerCommand} --answer <id>=<value>.`
      : `Waiting for ${waiting.length} decision${waiting.length === 1 ? "" : "s"}. Answer with ${answerCommand} --answer <id>=<value> --answered-by <you>.`
    : inspection.lifecycleState === "UNINITIALIZED" ? "Run paved init to initialize this project."
      : inspection.lifecycleState === "STALE" ? "Run paved update to refresh stale generated state."
        : inspection.lifecycleState === "BROKEN" || inspection.lifecycleState === "INCOMPATIBLE"
          ? "Run paved status and answer its repair decisions."
          : inspection.verificationProfile !== "present" ? "Run paved verify to choose repository checks."
            : 'Start work with paved intent "<request>" --json.';
  const nextAction = drifted && inspection.lifecycleState !== "STALE"
    ? `${baseAction} Generated project context cites changed source files; this does not block work, and paved update --json regenerates it.`
    : baseAction;
  return {
    initialized: inspection.initialized,
    lifecycleState: inspection.lifecycleState,
    projectRoot: inspection.projectRoot,
    coreRoot: inspection.coreRoot,
    projectName: inspection.projectName,
    core: inspection.core,
    selectedAdapters: inspection.selectedAdapters,
    detectedAdapters: inspection.detectedAdapters,
    resolvedAdapters: inspection.resolvedAdapters,
    capabilityProviders: inspection.capabilityProviders,
    lockHealth: inspection.lockHealth,
    verificationProfile: inspection.verificationProfile,
    ...(inspection.sourceRoot === undefined ? {} : { stateRoot: inspection.projectRoot, sourceRoot: inspection.sourceRoot }),
    ...(inspection.contextWorktrees === undefined ? {} : { contextWorktrees: inspection.contextWorktrees }),
    generatedContext: drifted ? "drifted" : "current",
    generatorState: inspection.lastRun ?? { present: false, proposals: [], conflicts: [] },
    proposals: inspection.proposals,
    conflicts: inspection.conflicts,
    pendingDecisions: inspection.pendingDecisions,
    pendingApprovals: inspection.pendingApprovals,
    verificationReadiness: inspection.verificationProfile === "present" ? "ready"
      : inspection.pendingDecisions.length > 0 ? "awaiting-decision" : "unconfigured",
    unavailableCommands,
    nextAction,
  };
}

function agentsBlockFindings(inspection: ConsumerInspection): Diagnostic[] {
  if (!inspection.initialized) return [];
  const agents = inspectAgentsBlock(inspection.coreRoot, inspection.projectRoot);
  if (agents.state === "invalid") return [agentsBlockInvalidDiagnostic(agents.reason)];
  if (agents.state !== "outdated") return [];
  return [createDiagnostic({
    severity: "warning", category: "findings", code: "PAVED_AGENTS_BLOCK_OUTDATED", component: "consumer.agents",
    message: "The managed Paved block in AGENTS.md differs from the current Core template.",
    remediation: "Run paved update to rewrite the managed block; text outside it is never changed.",
  })];
}

/** The latest run in this checkout, when it completed and its code changed afterwards. */
function staleCompletion(inspection: ConsumerInspection, runs: readonly Run[], sourceRoot: string): Diagnostic[] {
  const latest = runs.filter((run) => runBelongsTo(inspection.projectRoot, run, sourceRoot))
    .sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1);
  if (latest === undefined || !changedSinceVerification(inspection.projectRoot, latest)) return [];
  return [createDiagnostic({
    severity: "warning", category: "findings", code: "PAVED_WORKFLOW_EVIDENCE_STALE", component: "consumer.runs",
    message: `Source or test files changed after run ${latest.id} was verified and reviewed, so its evidence does not describe the current code.`,
    remediation: "If the later edits belong to that change, start a new run for them (or run paved verify) so tests, verification and review cover the code that ships.",
  })];
}

function openRuns(inspection: ConsumerInspection, sourceRoot: string): { runs: Record<string, unknown>[]; diagnostics: Diagnostic[] } {
  if (!inspection.initialized) return { runs: [], diagnostics: [] };
  const scanned = scanRuns(inspection.projectRoot, inspection.coreRoot);
  const runs = scanned.runs.filter((run) => isOpen(run) && runBelongsTo(inspection.projectRoot, run, sourceRoot)).map((run) => ({
    run: run.id, status: run.status, ...(run.workflow === undefined ? {} : { workflow: run.workflow.id }),
    ...(run.worktree === undefined ? {} : { worktree: run.worktree }),
    currentPhase: run.phases.find((phase) => phase.status === "running")?.phase,
    ...(run.handoff === undefined ? {} : { handoff: {
      ...run.handoff, fresh: fingerprint(runSourceRoot(inspection.projectRoot, run)) === run.handoff.source_sha256,
    } }),
  }));
  return { runs, diagnostics: [...scanned.unreadable.map((run) => createDiagnostic({
    severity: "warning", category: "findings", code: "PAVED_WORKFLOW_RUN_INVALID", component: "consumer.runs",
    message: `Workflow run ${run.id} could not be read: ${run.reason}`,
    remediation: "Inspect .paved/generated/runs/ and restore or remove the invalid run document.",
  })), ...staleCompletion(inspection, scanned.runs, sourceRoot)] };
}

/** An unreadable decision store is already reported by the inspection; repairs then wait for it to be fixed. */
function repairs(invocation: CommandInvocation): { projections: ReturnType<typeof runDecisionGate>["projections"]; problems: readonly string[] } {
  try {
    return runDecisionGate({
      context: {
        projectRoot: invocation.paths.projectRoot, sourceRoot: invocation.paths.sourceRoot, coreRoot: invocation.paths.coreRoot,
        command: "doctor", answers: invocation.flags.answers,
        ...(invocation.flags.answeredBy === undefined ? {} : { answeredBy: invocation.flags.answeredBy }),
      },
      providers: [repairProvider], handlers: new Map([["repair.apply", repairHandler]]),
      persist: invocation.flags.answers.length > 0,
    });
  } catch (error) {
    if (!(error instanceof DecisionStoreError)) throw error;
    return { projections: [], problems: [] };
  }
}

/** A broken Check, Tool or binding surfaces here, not only when `execute` reaches verification. */
function verificationFindings(invocation: CommandInvocation, inspection: ConsumerInspection): Diagnostic[] {
  if (!inspection.initialized || inspection.verificationProfile !== "present") return [];
  return inspectVerificationConfig({
    projectRoot: invocation.paths.projectRoot,
    coreRoot: invocation.paths.coreRoot,
    adapterSelections: inspection.selectedAdapters,
  }).map((item) => createDiagnostic({
    severity: "warning", category: "findings", code: item.code, component: item.component,
    message: item.message, remediation: item.remediation ?? "Fix the verification profile, Check or Tool binding it names.",
  }));
}

interface GuideCoverage {
  status: "draft" | "ready";
  features: { id: string; entrypoints?: string[] }[];
  deferred?: string[];
  sources: { location: string; sha256: string }[];
}
interface MappedFeature { status: string; entrypoints: Set<string>; userVisible: boolean }

const COMPONENT = "consumer.verification-guide";
// Entry points a person reaches directly; events, jobs, RPC and library calls are not walked through by a guide.
const USER_VISIBLE: ReadonlySet<string> = new Set(["ui", "http", "cli"]);
const RETIRED: ReadonlySet<string> = new Set(["deprecated", "removed"]);

const listed = (items: readonly string[]): string => items.length <= 8 ? items.join(", ") : `${items.slice(0, 8).join(", ")} and ${items.length - 8} more`;

/** Guides laid out by the app-verification skill: `.paved/skills/verify-<slug>/references/features.md`. */
function guidePaths(projectRoot: string): string[] {
  const skills = join(projectRoot, ".paved/skills");
  if (!existsSync(skills)) return [];
  return readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("verify-"))
    .map((entry) => `.paved/skills/${entry.name}/references/features.md`)
    .filter((path) => existsSync(join(projectRoot, path)))
    .sort();
}

/** The feature map by id; an unreadable entry is reported by its own validation, not here. */
function featureMap(projectRoot: string): Map<string, MappedFeature> {
  const dir = join(projectRoot, ".paved/project/feature-map");
  const features = new Map<string, MappedFeature>();
  if (!existsSync(dir)) return features;
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith(".yaml"))) {
    let doc: { kind?: unknown; id?: unknown; status?: unknown; code?: { entrypoints?: { kind?: unknown; name?: unknown }[] } } | null;
    try { doc = loadYaml(join(dir, entry.name)) as typeof doc; } catch { continue; }
    if (doc?.kind !== "Feature" || typeof doc.id !== "string") continue;
    const entrypoints = Array.isArray(doc.code?.entrypoints) ? doc.code.entrypoints : [];
    features.set(doc.id, {
      status: typeof doc.status === "string" ? doc.status : "active",
      entrypoints: new Set(entrypoints.flatMap((item) => typeof item?.name === "string" ? [item.name] : [])),
      userVisible: entrypoints.some((item) => USER_VISIBLE.has(String(item?.kind))),
    });
  }
  return features;
}

function changedSources(projectRoot: string, sources: GuideCoverage["sources"]): string[] {
  return sources.filter((source) => {
    let path: string;
    try { path = resolveSafePath(projectRoot, source.location); } catch { return true; }
    return !existsSync(path) || createHash("sha256").update(readFileSync(path)).digest("hex") !== source.sha256;
  }).map((source) => source.location);
}

function inspectGuide(projectRoot: string, guide: string, coverage: GuideCoverage, features: Map<string, MappedFeature>): Diagnostic[] {
  const findings: Diagnostic[] = [];
  const finding = (code: string, message: string, remediation: string) =>
    findings.push(createDiagnostic({ severity: "warning", category: "findings", code, component: COMPONENT, message, remediation }));

  const missing = coverage.features.flatMap(({ id, entrypoints }) => {
    const mapped = features.get(id);
    if (mapped === undefined || mapped.status === "removed") return [id];
    return (entrypoints ?? []).filter((name) => !mapped.entrypoints.has(name)).map((name) => `${id} ${name}`);
  });
  if (missing.length > 0) {
    finding("PAVED_VERIFICATION_GUIDE_FEATURE_MISSING", `${guide} covers features or entry points that are no longer in the feature map: ${listed(missing)}.`,
      "Update the guide with the app-verification skill: confirm each claim against the source, then drop or rename it; Paved does not rewrite the guide.");
  }

  const known = new Set([...coverage.features.map((feature) => feature.id), ...(coverage.deferred ?? [])]);
  const uncovered = [...features].filter(([id, feature]) => feature.userVisible && !RETIRED.has(feature.status) && !known.has(id)).map(([id]) => id).sort();
  if (uncovered.length > 0) {
    finding("PAVED_VERIFICATION_GUIDE_FEATURE_UNCOVERED", `The feature map has user-visible features ${guide} neither covers nor defers: ${listed(uncovered)}.`,
      "Add them to the guide, or list them under `deferred` in its frontmatter when they are knowingly left for later.");
  }

  const stale = changedSources(projectRoot, coverage.sources);
  if (stale.length > 0) {
    finding("PAVED_VERIFICATION_GUIDE_STALE", `${guide} was written from feature-map documents that changed or no longer exist since: ${listed(stale)}.`,
      "Recheck the affected features against the source with the app-verification skill and record the new digests.");
  }
  return findings;
}

/**
 * Read-only drift between each app verification guide and the feature map. Only the
 * guide's frontmatter is read; its prose is the project's own and is never interpreted.
 */
export function inspectVerificationGuides(projectRoot: string, coreRoot: string): Diagnostic[] {
  const guides = guidePaths(projectRoot);
  if (guides.length === 0) return [];
  const registry = createRegistry(join(coreRoot, "schemas"), ["paved/v1"]);
  const features = featureMap(projectRoot);
  return guides.flatMap((guide) => {
    let frontmatter: Record<string, unknown>;
    try { frontmatter = loadMarkdown(join(projectRoot, guide)).frontmatter; } catch { frontmatter = { kind: "VerificationGuide" }; }
    if (frontmatter.kind !== "VerificationGuide") {
      return [createDiagnostic({
        severity: "info", category: "findings", code: "PAVED_VERIFICATION_GUIDE_UNTRACKED", component: COMPONENT,
        message: `${guide} does not record which feature-map entries it covers, so drift from the feature map cannot be checked.`,
        remediation: "Add VerificationGuide frontmatter as the app-verification skill describes.",
      })];
    }
    const validation = registry.validate(frontmatter);
    if (!validation.valid) {
      return [createDiagnostic({
        severity: "warning", category: "findings", code: "PAVED_VERIFICATION_GUIDE_INVALID", component: COMPONENT,
        message: `${guide} has frontmatter that does not match the VerificationGuide schema: ${validation.errors.join("; ")}`,
        remediation: "Fix the frontmatter of the guide's references/features.md.",
      })];
    }
    return inspectGuide(projectRoot, guide, frontmatter as unknown as GuideCoverage, features);
  });
}

/** `status` and the `doctor` CLI subcommand share this; repairs keep the `doctor` decision ids. */
export function diagnose(invocation: CommandInvocation, command: "status" | "doctor"): CommandResult {
  const inspection = inspectConsumer({
    projectRoot: invocation.paths.projectRoot,
    sourceRoot: invocation.paths.sourceRoot,
    coreRoot: invocation.paths.coreRoot,
    adapterSelections: invocation.flags.adapters,
    ...(invocation.paths.manifestPath === undefined ? {} : { manifestPath: invocation.paths.manifestPath }),
  });
  const outcome = repairs(invocation);
  const decisionDiagnostics = outcome.problems.map((message) => createDiagnostic({
    severity: "error", category: "usage", code: "PAVED_DECISION_ANSWER_INVALID",
    component: `cli.${command}`, message,
    remediation: "Use the offered option id and provide the required human-authored approval.",
  }));
  const runs = openRuns(inspection, invocation.paths.sourceRoot);
  const diagnostics = [...inspection.diagnostics, ...agentsBlockFindings(inspection), ...runs.diagnostics,
    ...verificationFindings(invocation, inspection),
    ...(inspection.initialized ? inspectVerificationGuides(inspection.projectRoot, inspection.coreRoot) : []), ...decisionDiagnostics];
  const onlyOpenRun = runs.runs.length === 1 ? runs.runs[0] : undefined;
  const resumeAction = onlyOpenRun === undefined ? undefined : `Resume the matching run with paved execute --run ${onlyOpenRun.run} --json; read its handoff first${(onlyOpenRun.handoff as { fresh?: boolean } | undefined)?.fresh === false ? " (the checkpoint is stale; inspect the current changes)" : ""}.`;
  return createResult({
    command,
    status: statusFor(diagnostics),
    decisions: outcome.projections,
    data: {
      ...statusData(inspection),
      openRuns: runs.runs,
      ...(resumeAction === undefined ? {} : { nextAction: resumeAction }),
      actionableFindings: diagnostics.filter((item) => item.code !== "PAVED_DECISION_ANSWER_INVALID" && item.severity !== "info").map((diagnostic) => ({
        code: diagnostic.code, severity: diagnostic.severity, category: diagnostic.category,
        component: diagnostic.component, message: diagnostic.message, remediation: diagnostic.remediation,
      })),
    },
    diagnostics,
  });
}

export function statusHandler(invocation: CommandInvocation): CommandResult {
  return diagnose(invocation, "status");
}
